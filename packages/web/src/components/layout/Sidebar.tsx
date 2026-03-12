'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const nav = [
  { href: '/', label: 'Dashboard', icon: '~' },
  { href: '/projects', label: 'Projects', icon: '#' },
  { href: '/activity', label: 'Activity', icon: '>' },
  { href: '/schedules', label: 'Schedules', icon: '@' },
  { href: '/processes', label: 'Processes', icon: '!' },
  { href: '/skills', label: 'Skills', icon: '*' },
  { href: '/settings', label: 'Settings', icon: '%' },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="w-56 h-screen flex flex-col border-r"
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <h1 className="text-lg font-bold tracking-tight" style={{ color: 'var(--accent)' }}>
          RAVEN
        </h1>
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          Personal Assistant
        </p>
      </div>
      <nav className="flex-1 p-2 space-y-1">
        {nav.map((item) => {
          const active =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors"
              style={{
                background: active ? 'var(--bg-hover)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-muted)',
              }}
            >
              <span className="w-4 text-center font-mono">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
