import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { readToken } from '@/lib/session';
import { signOut } from './sign-in/actions';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'SupplyPilot', template: '%s · SupplyPilot' },
  description: 'Inventory intelligence for multi-location merchants',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const signedIn = (await readToken()) !== null;
  return (
    <html lang="en">
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <header className="topbar">
          <Link href="/" className="brand">
            SupplyPilot
          </Link>
          {signedIn && (
            <nav aria-label="Account">
              <Link href="/orgs">Organizations</Link>
              <form action={signOut}>
                <button type="submit" className="link-button">
                  Sign out
                </button>
              </form>
            </nav>
          )}
        </header>
        <main id="main">{children}</main>
      </body>
    </html>
  );
}
