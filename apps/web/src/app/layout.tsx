import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Hexalyte Reseller Platform',
  description: 'Hexalyte central reseller platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
