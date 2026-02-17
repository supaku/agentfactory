import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Supaku Family — The personal CRM that treats your relationships like they matter',
  description:
    'The personal CRM for tech professionals who know their relationships are too important for ad-supported software. Contact management, relationship health tracking, AI-powered reminders.',
  openGraph: {
    title: 'Supaku Family — Personal CRM for People Who Care',
    description:
      'The personal CRM for tech professionals. Contact management, relationship health, reminders, and AI messaging — all private, no ads.',
    type: 'website',
    locale: 'en_US',
    siteName: 'Supaku Family',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Supaku Family — Personal CRM for People Who Care',
    description:
      'The personal CRM for tech professionals. No ads. No data selling. No compromise.',
  },
  robots: {
    index: true,
    follow: true,
  },
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300..700;1,9..40,300..700&family=Syne:wght@400..800&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased font-body">{children}</body>
    </html>
  )
}
