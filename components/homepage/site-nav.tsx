"use client";

import { useEffect, useState, useSyncExternalStore } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme, applyThemeClient } from '@/components/theme-toggle';
import { Icon } from './icon';

export const siteNavItems = [
  { label: 'How it works', href: '/how-it-works' },
  { label: 'Security', href: '/security' },
  { label: 'AI agents', href: '/for-agents' },
  { label: 'Compare', href: '/compare' },
  { label: 'Developers', href: '/developers' },
  { label: 'Agents', href: '/agents' },
] as const;

function subscribeSystemTheme(notify: () => void) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', notify);
  return () => media.removeEventListener('change', notify);
}
function getSystemDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }

/** The public site's header. It sits on the photo at the top of every marketing page. */
/**
 * Where a menu item goes. Signed in, /security is the workspace's own Security
 * area, so the public site's Security link opens the same public page instead
 * (/security-check): logged in or out, Security here is the public page.
 */
export function siteNavHref(href: string, signedIn: boolean): string {
  return signedIn && href === '/security' ? '/security-check' : href;
}

export function SiteNav({ signedIn = false }: { signedIn?: boolean }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [theme, setTheme] = useTheme();
  const systemDark = useSyncExternalStore(subscribeSystemTheme, getSystemDark, () => false);
  const darkMode = theme === 'dark' || (theme === 'system' && systemDark);

  useEffect(() => {
    // Reapply a device preference after hydration when no account/cookie pins it.
    if (!document.documentElement.hasAttribute('data-theme')) {
      try {
        const saved = window.localStorage.getItem('theme');
        if (saved === 'light' || saved === 'dark') applyThemeClient(saved);
      } catch { /* Storage may be unavailable in private browsing. */ }
    }
  }, []);

  useEffect(() => {
    const close = () => setMenuOpen(false);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('resize', close);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('resize', close); window.removeEventListener('keydown', escape); };
  }, []);

  return (
    <header className="th-nav">
      <Link className="th-brand" href="/" aria-label="Ziki home">
        <span className="th-mark"><Image src="/homepage/ziki-mark.svg" width={22} height={22} alt="" /></span>
        Ziki
      </Link>
      <nav id="homepage-navigation" className={menuOpen ? 'th-links open' : 'th-links'} aria-label="Main navigation">
        {siteNavItems.map((item) => (
          <Link
            href={siteNavHref(item.href, signedIn)}
            key={item.href}
            aria-current={pathname === siteNavHref(item.href, signedIn) || pathname?.startsWith(`${item.href}/`) ? 'page' : undefined}
            onClick={() => setMenuOpen(false)}
          >
            {item.label}
          </Link>
        ))}
        <Link className="th-btn th-btn-dark th-menu-cta" href={signedIn ? '/home' : '/login'} onClick={() => setMenuOpen(false)}>{signedIn ? 'Open organisation' : 'Get started'}</Link>
      </nav>
      <div className="th-actions">
        <button
          className="th-icon-btn"
          type="button"
          aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={() => {
            const next = darkMode ? 'light' : 'dark';
            if (signedIn) setTheme(next);
            else applyThemeClient(next);
          }}
        >
          <Icon name={darkMode ? 'sun' : 'moon'} size={16} />
        </button>
        {signedIn ? (
          <Link className="th-btn th-btn-dark th-desktop" href="/home">Open organisation</Link>
        ) : (
          <>
            <Link className="th-btn th-btn-light th-desktop" href="/login">Login</Link>
            <Link className="th-btn th-btn-dark th-desktop" href="/login">Get started</Link>
          </>
        )}
        <button className="th-icon-btn th-menu-button" type="button" aria-controls="homepage-navigation" aria-label={menuOpen ? 'Close menu' : 'Open menu'} aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}>
          <Icon name={menuOpen ? 'x' : 'menu'} size={18} />
        </button>
      </div>
    </header>
  );
}
