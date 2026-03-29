'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Project } from '@/lib/api-client';

interface TreeNode {
  project: Project;
  children: TreeNode[];
}

function buildTree(projects: Project[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const p of projects) {
    map.set(p.id, { project: p, children: [] });
  }

  for (const p of projects) {
    const node = map.get(p.id)!;
    const parentId = (p as Project & { parentId?: string }).parentId;
    if (parentId && map.has(parentId)) {
      map.get(parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const p = node.project;

  return (
    <div>
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-md transition-colors"
        style={{
          paddingLeft: `${depth * 20 + 12}px`,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          marginBottom: '2px',
        }}
      >
        {hasChildren ? (
          <button
            onClick={() => setExpanded(!expanded)}
            className="w-4 text-center font-mono text-xs"
            style={{ color: 'var(--text-muted)' }}
          >
            {expanded ? 'v' : '>'}
          </button>
        ) : (
          <span className="w-4" />
        )}
        {p.isMeta && (
          <span className="font-mono text-sm" style={{ color: 'var(--accent)' }}>
            $
          </span>
        )}
        <Link
          href={`/projects/${p.id}`}
          className="text-sm font-medium hover:underline"
          style={{ color: 'var(--text)' }}
        >
          {p.name}
        </Link>
        {p.description && (
          <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
            — {p.description}
          </span>
        )}
        <div className="flex gap-1 ml-auto flex-shrink-0">
          {p.skills.slice(0, 3).map((s) => (
            <span
              key={s}
              className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: 'var(--bg-hover)', color: 'var(--accent)' }}
            >
              {s}
            </span>
          ))}
          {p.skills.length > 3 && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              +{p.skills.length - 3}
            </span>
          )}
        </div>
      </div>
      {expanded &&
        hasChildren &&
        node.children.map((child) => (
          <TreeItem key={child.project.id} node={child} depth={depth + 1} />
        ))}
    </div>
  );
}

export function ProjectTree({ projects }: { projects: Project[] }) {
  const tree = buildTree(projects);

  if (projects.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        No projects yet. Create one to start chatting with Raven.
      </p>
    );
  }

  return (
    <div className="space-y-0.5">
      {tree.map((node) => (
        <TreeItem key={node.project.id} node={node} depth={0} />
      ))}
    </div>
  );
}
