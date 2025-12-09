import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "EAA Scanner Dashboard",
  description: "A11y scans overview",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Ubuntu, Cantarell, Noto Sans, sans-serif', color: '#111', background: '#fafafa' }}>
        <header style={{ padding: '12px 16px', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{ fontWeight: 700 }}>EAA: WCAG Dashboard</div>
          <nav style={{ display: 'flex', gap: 12 }}>
            <Link href="/" style={{ color: '#111' }}>Accueil</Link>
            <Link href="/declaration" style={{ color: '#111' }}>Déclaration</Link>
            <Link href="/sites/test-site" style={{ color: '#111' }}>Site: test-site</Link>
            <Link href="/chrome-enterprise" style={{ color: '#111' }}>Chrome Enterprise</Link>
          </nav>
        </header>
        <main style={{ padding: 16, maxWidth: 1200, margin: '0 auto' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
