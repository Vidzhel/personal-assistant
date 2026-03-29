'use client';

import { useState, useEffect } from 'react';
import { Sidebar } from './Sidebar';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

// eslint-disable-next-line max-lines-per-function -- layout component managing responsive sidebar states
export function ResponsiveLayout({ children }: { children: React.ReactNode }) {
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isTablet = useMediaQuery('(min-width: 768px)');
  const [mobileOpen, setMobileOpen] = useState(false);

  // Close mobile drawer on route change (desktop/tablet don't need this)
  useEffect(() => {
    if (isTablet) setMobileOpen(false);
  }, [isTablet]);

  // Desktop: full sidebar
  if (isDesktop) {
    return (
      <>
        <Sidebar />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </>
    );
  }

  // Tablet: collapsed icon-only sidebar
  if (isTablet) {
    return (
      <>
        <Sidebar collapsed />
        <main className="flex-1 overflow-y-auto">{children}</main>
      </>
    );
  }

  // Mobile: hidden sidebar with hamburger toggle
  return (
    <>
      {/* Top bar with hamburger */}
      <div
        className="fixed top-0 left-0 right-0 z-40 flex items-center h-12 px-4 border-b"
        style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
      >
        <button
          onClick={() => setMobileOpen(true)}
          className="p-1.5 rounded"
          style={{ color: 'var(--text)' }}
          aria-label="Open navigation"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor">
            <path
              d="M3 5h14M3 10h14M3 15h14"
              stroke="currentColor"
              strokeWidth="1.5"
              fill="none"
              strokeLinecap="round"
            />
          </svg>
        </button>
        <span className="ml-3 text-sm font-bold" style={{ color: 'var(--accent)' }}>
          RAVEN
        </span>
      </div>

      {/* Overlay drawer */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40"
            style={{ background: 'rgba(0,0,0,0.5)' }}
            onClick={() => setMobileOpen(false)}
          />
          <div className="fixed inset-y-0 left-0 z-50">
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </div>
        </>
      )}

      <main className="flex-1 overflow-y-auto pt-12">{children}</main>
    </>
  );
}
