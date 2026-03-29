'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const META_PROJECT_ID = 'meta';

const nav = [
  { href: '/', label: 'Dashboard', icon: '~' },
  { href: '/projects', label: 'Projects', icon: '#' },
  { href: '/activity', label: 'Activity', icon: '>' },
  { href: '/pipelines', label: 'Pipelines', icon: '|' },
  { href: '/templates', label: 'Templates', icon: 'T' },
  { href: '/tasks', label: 'Tasks', icon: '=' },
  { href: '/task-trees', label: 'Task Trees', icon: '+' },
  { href: '/metrics', label: 'Metrics', icon: '%' },
  { href: '/schedules', label: 'Schedules', icon: '@' },
  { href: '/agents', label: 'Agents', icon: '^' },
  { href: '/skills', label: 'Skills', icon: '*' },
  { href: '/knowledge', label: 'Knowledge', icon: '?' },
  { href: '/config-history', label: 'Config', icon: '{' },
  { href: '/logs', label: 'Logs', icon: '!' },
  { href: '/settings', label: 'Settings', icon: '&' },
];

// eslint-disable-next-line max-lines-per-function -- sidebar with meta-project pinned section
export function Sidebar() {
  const pathname = usePathname() ?? '/';
  const metaHref = `/projects/${META_PROJECT_ID}`;
  const metaActive = pathname === metaHref;

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

      {/* Meta-project pinned at top */}
      <div className="px-2 pt-2">
        <Link
          href={metaHref}
          aria-current={metaActive ? 'page' : undefined}
          className="flex items-center gap-3 px-3 py-2 rounded-md text-sm transition-colors"
          style={{
            background: metaActive ? 'var(--bg-hover)' : 'transparent',
            color: metaActive ? 'var(--accent)' : 'var(--text-muted)',
          }}
        >
          <span className="w-4 text-center font-mono" title="System">
            {'$'}
          </span>
          Raven System
        </Link>
      </div>
      <div className="mx-3 border-b" style={{ borderColor: 'var(--border)' }} />

      <nav className="flex-1 p-2 space-y-1">
        {nav.map((item) => {
          const active =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
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
