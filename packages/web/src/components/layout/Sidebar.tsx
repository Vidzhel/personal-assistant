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

interface SidebarProps {
  collapsed?: boolean;
  onNavigate?: () => void;
}

// eslint-disable-next-line max-lines-per-function, complexity -- sidebar with collapsed/expanded modes
export function Sidebar({ collapsed, onNavigate }: SidebarProps) {
  const pathname = usePathname() ?? '/';
  const metaHref = `/projects/${META_PROJECT_ID}`;
  const metaActive = pathname === metaHref;

  const widthClass = collapsed ? 'w-14' : 'w-56';

  return (
    <aside
      className={`${widthClass} h-screen flex flex-col border-r flex-shrink-0`}
      style={{ borderColor: 'var(--border)', background: 'var(--bg)' }}
    >
      <div className="p-4 border-b" style={{ borderColor: 'var(--border)' }}>
        <h1
          className={`font-bold tracking-tight ${collapsed ? 'text-sm text-center' : 'text-lg'}`}
          style={{ color: 'var(--accent)' }}
        >
          {collapsed ? 'R' : 'RAVEN'}
        </h1>
        {!collapsed && (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Personal Assistant
          </p>
        )}
      </div>

      {/* Meta-project pinned at top */}
      <div className="px-2 pt-2">
        <Link
          href={metaHref}
          onClick={onNavigate}
          aria-current={metaActive ? 'page' : undefined}
          className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-md text-sm transition-colors`}
          style={{
            background: metaActive ? 'var(--bg-hover)' : 'transparent',
            color: metaActive ? 'var(--accent)' : 'var(--text-muted)',
          }}
          title={collapsed ? 'Raven System' : undefined}
        >
          <span className="w-4 text-center font-mono" title="System">
            {'$'}
          </span>
          {!collapsed && 'Raven System'}
        </Link>
      </div>
      <div className="mx-3 border-b" style={{ borderColor: 'var(--border)' }} />

      <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
        {nav.map((item) => {
          const active =
            pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={`flex items-center ${collapsed ? 'justify-center' : 'gap-3'} px-3 py-2 rounded-md text-sm transition-colors`}
              style={{
                background: active ? 'var(--bg-hover)' : 'transparent',
                color: active ? 'var(--text)' : 'var(--text-muted)',
              }}
              title={collapsed ? item.label : undefined}
            >
              <span className="w-4 text-center font-mono">{item.icon}</span>
              {!collapsed && item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
