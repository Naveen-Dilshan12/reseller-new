import { useLoginBranding } from '@/lib/login-branding'

/**
 * Test-only component: renders what the login-branding hook returns into an input, so tests/login-branding.test.ts can
 * read it back through the render harness (`valueOf`). It has no behaviour of its own.
 */
export function Probe() {
  const state = useLoginBranding()
  return (
    <div>
      <input id="state" value={JSON.stringify(state)} />
    </div>
  )
}
