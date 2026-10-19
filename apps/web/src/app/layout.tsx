import type { Metadata } from 'next'
import { ThemeProvider } from '@/lib/theme'
import { LanguageProvider } from '@/lib/i18n'
import { themeScript } from '@/lib/theme-script'
import './globals.css'

export const metadata: Metadata = {
  title: 'Hexalyte Partner Platform',
  description: 'Hexalyte central partner platform',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ThemeProvider>
          <LanguageProvider>{children}</LanguageProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
