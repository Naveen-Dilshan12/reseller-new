'use client'

import { useAppearance, useProtectedImage } from '@/lib/appearance'

/**
 * The platform logo: the admin's uploaded logo when there is one, otherwise `fallback` (the built-in "H" mark).
 * While a custom logo is still downloading an empty box of the same size is shown, so the built-in mark does not
 * flash before it. If the download fails the built-in mark is shown. `className` goes on the logo or its placeholder.
 */
export function PlatformLogo({ size, radius = 8, className, fallback }: { size: number; radius?: number; className?: string; fallback: React.ReactNode }) {
  const appearance = useAppearance()
  const logo = appearance?.logo ?? null
  const { url, status } = useProtectedImage(logo ? '/appearance/logo' : null, logo?.version)

  if (url) {
    return <img className={className} src={url} alt="" width={size} height={size} style={{ width: size, height: size, borderRadius: radius, objectFit: 'contain', flexShrink: 0 }} />
  }
  if (status === 'loading') return <div className={className} aria-hidden="true" style={{ width: size, height: size, flexShrink: 0 }} />
  return <>{fallback}</>
}
