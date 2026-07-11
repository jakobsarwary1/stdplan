import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'FleetOS',
  description: 'Verwaltungsplattform für Mietwagen- und Taxiunternehmen'
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>{children}</body>
    </html>
  )
}
