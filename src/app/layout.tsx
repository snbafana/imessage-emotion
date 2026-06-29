import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Undercurrent — Emotion Timeline',
  description: 'How emotion in your iMessage conversations shifts over time.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
