import fs from 'node:fs'
import ts from 'typescript'

/**
 * Runs a real, unmodified Next.js client page (`page.tsx`) in Node with no DOM, so its behaviour can be tested
 * (clicks, state, timers). The page is transpiled with the project's own `typescript`, its imports are replaced by
 * the stubs a test passes in, and a minimal hook runtime stands in for React: `useState`, `useEffect` (with cleanup
 * and dependency comparison) and `useCallback`.
 *
 * Limits, on purpose: components used inside the page must be plain functions without hooks (stubs and small local
 * helpers are fine); updates re-render synchronously rather than batched; there is no layout, CSS or browser API.
 */

type Cell = { value?: unknown; deps?: unknown[]; cleanup?: unknown; setter?: (next: unknown) => void; fn?: unknown }
export interface Elem {
  type: unknown
  props: Record<string, any>
}

let active: Runtime | null = null
const current = (hook: string) => {
  if (!active) throw new Error(`${hook} was used outside the page component (hooks in child components are not supported by this harness)`)
  return active
}

class Runtime {
  cells: Cell[] = []
  cursor = 0
  effects: Array<() => void> = []
  tree: unknown = null
  renders = 0
  mounted = true
  private rendering = false
  private dirty = false

  constructor(private readonly component: () => unknown) {}

  render() {
    if (!this.mounted) return
    if (this.rendering) {
      this.dirty = true
      return
    }
    this.rendering = true
    try {
      do {
        this.dirty = false
        this.cursor = 0
        this.effects = []
        active = this
        let out: unknown
        try {
          out = this.component()
        } finally {
          active = null
        }
        this.tree = expand(out)
        this.renders++
        for (const run of this.effects) run()
      } while (this.dirty && this.mounted)
    } finally {
      this.rendering = false
    }
  }

  unmount() {
    this.mounted = false
    for (const cell of this.cells) if (typeof cell.cleanup === 'function') cell.cleanup()
  }
}

export const Fragment = Symbol('Fragment')
export function jsx(type: unknown, props: Record<string, any> | null, key?: unknown): Elem {
  return { type, props: { ...(props ?? {}), ...(key === undefined ? {} : { key }) } }
}

export const hooks = {
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void] {
    const rt = current('useState')
    const cell = (rt.cells[rt.cursor] ??= { value: typeof initial === 'function' ? (initial as () => T)() : initial })
    rt.cursor++
    cell.setter ??= (next) => {
      const value = typeof next === 'function' ? (next as (prev: unknown) => unknown)(cell.value) : next
      if (Object.is(value, cell.value)) return
      cell.value = value
      rt.render()
    }
    return [cell.value as T, cell.setter as (next: T | ((prev: T) => T)) => void]
  },
  useEffect(fn: () => unknown, deps?: unknown[]) {
    const rt = current('useEffect')
    const cell = (rt.cells[rt.cursor] ??= {})
    rt.cursor++
    const changed = !cell.deps || !deps || deps.some((d, i) => !Object.is(d, cell.deps![i]))
    if (!changed) return
    rt.effects.push(() => {
      if (typeof cell.cleanup === 'function') cell.cleanup()
      cell.cleanup = fn()
      cell.deps = deps
    })
  },
  useRef<T>(initial: T): { current: T } {
    const rt = current('useRef')
    const cell = (rt.cells[rt.cursor] ??= { value: { current: initial } })
    rt.cursor++
    return cell.value as { current: T }
  },
  useCallback<T>(fn: T, deps: unknown[]): T {
    const rt = current('useCallback')
    const cell = (rt.cells[rt.cursor] ??= {})
    rt.cursor++
    if (!cell.deps || deps.some((d, i) => !Object.is(d, cell.deps![i]))) {
      cell.fn = fn
      cell.deps = deps
    }
    return cell.fn as T
  },
}

/** Turns the element tree into plain host elements by calling function components (outside the hook scope). */
function expand(node: any): any {
  if (node === null || node === undefined || typeof node === 'boolean') return null
  if (typeof node === 'string' || typeof node === 'number') return node
  if (Array.isArray(node)) return node.map(expand)
  if (typeof node.type === 'function') return expand(node.type(node.props))
  if (node.type === Fragment) return expand(node.props.children)
  return { type: node.type, props: { ...node.props, children: expand(node.props.children) } }
}

function textOf(node: any): string {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    // Adjacent text joins as in the browser ("of 3" + "." → "of 3."); separate elements are spaced for readability.
    let out = ''
    let previousWasText = false
    for (const child of node) {
      const text = textOf(child)
      if (!text) continue
      const isText = typeof child === 'string' || typeof child === 'number'
      out += out && !(isText && previousWasText) ? ` ${text}` : text
      previousWasText = isText
    }
    return out
  }
  return textOf(node.props?.children)
}

function walk(node: any, visit: (el: Elem) => void) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit))
  visit(node)
  walk(node.props?.children, visit)
}

function loadComponent(file: string, stubs: Record<string, unknown>, exportName = 'default'): (props: object) => unknown {
  const source = fs.readFileSync(file, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  })
  const module: { exports: Record<string, unknown> } = { exports: {} }
  const req = (name: string) => {
    if (!(name in stubs)) throw new Error(`The page imports "${name}", which this test did not stub`)
    return stubs[name]
  }
  new Function('require', 'module', 'exports', outputText)(req, module, module.exports)
  const component = module.exports[exportName]
  if (typeof component !== 'function') throw new Error(`${file} has no component export "${exportName}"`)
  return component as (props: object) => unknown
}

const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve))
}

/**
 * Mounts a page (its default export), or any other component of the file via `exportName`, with optional `props`.
 */
export function mountPage(file: string, stubs: Record<string, unknown>, options: { exportName?: string; props?: object } = {}) {
  const Page = loadComponent(file, { 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment }, react: hooks, ...stubs }, options.exportName)
  let props = options.props ?? {}
  const runtime = new Runtime(() => Page(props))
  runtime.render()

  const buttons = () => {
    const found: Elem[] = []
    walk(runtime.tree, (el) => el.type === 'button' && found.push(el))
    return found
  }
  const byId = (id: string) => {
    let found: Elem | undefined
    walk(runtime.tree, (el) => {
      if (!found && el.props?.id === id) found = el
    })
    return found
  }
  return {
    settle,
    /** Renders again with new props, as the page's parent would after one of its own state changes (state and effects are kept). */
    setProps(next: object) {
      props = next
      runtime.render()
    },
    get renders() {
      return runtime.renders
    },
    /** Types into the field with this id (calls its onChange with `{ target: { value } }`). */
    async fill(id: string, value: string) {
      const field = byId(id)
      if (!field) throw new Error(`No field with id "${id}" on the page`)
      field.props.onChange?.({ target: { value } })
      await settle()
    },
    /** Ticks or unticks the checkbox with this id (calls its onChange with `{ target: { checked } }`). */
    async toggle(id: string, checked: boolean) {
      const field = byId(id)
      if (!field) throw new Error(`No field with id "${id}" on the page`)
      field.props.onChange?.({ target: { checked, value: String(checked) } })
      await settle()
    },
    /** Calls the onChange of the field with this id with any `target`, e.g. `{ files: [file] }` for a file input. */
    async change(id: string, target: Record<string, unknown>) {
      const field = byId(id)
      if (!field) throw new Error(`No field with id "${id}" on the page`)
      field.props.onChange?.({ target })
      await settle()
    },
    /** Current `value` prop of the field with this id. */
    valueOf: (id: string) => byId(id)?.props.value,
    /** Every link on the page: where it goes and what it says. */
    links() {
      const found: Array<{ href: string; text: string }> = []
      walk(runtime.tree, (el) => el.type === 'a' && found.push({ href: String(el.props.href), text: textOf(el).trim() }))
      return found
    },
    isDisabled: (label: string) => Boolean(buttons().find((b) => textOf(b).trim() === label)?.props.disabled),
    text: () => textOf(runtime.tree),
    /** Visible labels of every button on the page. */
    buttonLabels: () => buttons().map((b) => textOf(b).trim()),
    hasButton: (label: string) => buttons().some((b) => textOf(b).trim() === label),
    /** Submits a form on the page (the first, or the `index`-th, 0-based): calls its onSubmit with a stub event, as the submit button or Enter does. */
    async submit(index = 0) {
      const forms: Elem[] = []
      walk(runtime.tree, (el) => el.type === 'form' && forms.push(el))
      const form = forms[index]
      if (!form) throw new Error(index === 0 ? 'No form on the page' : `No form number ${index} on the page (${forms.length} found)`)
      await form.props.onSubmit?.({ preventDefault() {} })
      await settle()
    },
    async click(label: string) {
      const button = buttons().find((b) => textOf(b).trim() === label)
      if (!button) throw new Error(`No "${label}" button on the page. Buttons: ${JSON.stringify(buttons().map((b) => textOf(b).trim()))}`)
      await button.props.onClick?.()
      await settle()
    },
    /** The rendered root element (type + props, children expanded), e.g. to read the style the page puts on its outermost box. */
    root: () => runtime.tree as Elem,
    /** Clicks the `index`-th (0-based) button with this label, for lists that repeat a button on every row. */
    async clickAt(label: string, index: number) {
      const button = buttons().filter((b) => textOf(b).trim() === label)[index]
      if (!button) throw new Error(`No "${label}" button number ${index} on the page. Buttons: ${JSON.stringify(buttons().map((b) => textOf(b).trim()))}`)
      await button.props.onClick?.()
      await settle()
    },
    /** Text of elements whose className contains `name` (e.g. "alert"). */
    textOfClass(name: string) {
      const out: string[] = []
      walk(runtime.tree, (el) => typeof el.props?.className === 'string' && el.props.className.includes(name) && out.push(textOf(el).trim()))
      return out
    },
    unmount: () => runtime.unmount(),
  }
}
