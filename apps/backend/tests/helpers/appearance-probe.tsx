import { useAppearance, useProtectedImage } from '@/lib/appearance'

/**
 * Test-only component: renders what the appearance hooks return into inputs, so tests/appearance-client.test.ts can
 * read it back through the render harness (`valueOf`). It has no behaviour of its own.
 */
export function Probe() {
  const appearance = useAppearance()
  const hero = useProtectedImage(appearance?.heroImage ? '/appearance/hero-image' : null, appearance?.heroImage?.version)
  return (
    <div>
      <input id="appearance" value={JSON.stringify(appearance)} />
      <input id="hero" value={JSON.stringify(hero)} />
    </div>
  )
}
