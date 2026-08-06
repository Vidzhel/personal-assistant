'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Project } from '@/lib/api-client';

interface TreeNode {
  project: Project;
  children: TreeNode[];
}

const INDENT_PER_DEPTH_PX = 20;
const BASE_INDENT_PX = 12;

function buildTree(projects: Project[]): TreeNode[] {
  const map = new Map<string, TreeNode>();
  const roots: TreeNode[] = [];

  for (const p of projects) {
    map.set(p.id, { project: p, children: [] });
  }

  for (const p of projects) {
    const node = map.get(p.id);
    if (!node) continue;
    const parentId = (p as Project & { parentId?: string }).parentId;
    const parent = parentId ? map.get(parentId) : undefined;
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function TreeItemBadges({
  agentCount,
  templateCount,
}: {
  agentCount?: number;
  templateCount?: number;
}) {
  return (
    <div className="flex gap-2 ml-auto flex-shrink-0">
      {(agentCount ?? 0) > 0 && (
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(99,102,241,0.2)', color: 'rgb(129,140,248)' }}
        >
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </span>
      )}
      {(templateCount ?? 0) > 0 && (
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ background: 'rgba(168,85,247,0.2)', color: 'rgb(192,132,252)' }}
        >
          {templateCount} template{templateCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}

function TreeItemToggle({
  hasChildren,
  expanded,
  onToggle,
}: {
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!hasChildren) return <span className="w-4" />;
  return (
    <button
      onClick={onToggle}
      className="w-4 text-center font-mono text-xs"
      style={{ color: 'var(--text-muted)' }}
    >
      {expanded ? 'v' : '>'}
    </button>
  );
}

function TreeItemLabel({ project }: { project: Project }) {
  return (
    <>
      {project.isMeta && (
        <span className="font-mono text-sm" style={{ color: 'var(--accent)' }}>
          $
        </span>
      )}
      <Link
        href={`/projects/${project.id}`}
        className="text-sm font-medium hover:underline"
        style={{ color: 'var(--text)' }}
      >
        {project.name}
      </Link>
      {project.description && (
        <span className="text-xs truncate" style={{ color: 'var(--text-muted)' }}>
          — {project.description}
        </span>
      )}
    </>
  );
}

function TreeItemRow({
  project,
  depth,
  hasChildren,
  expanded,
  onToggle,
}: {
  project: Project;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-md transition-colors"
      style={{
        paddingLeft: `${depth * INDENT_PER_DEPTH_PX + BASE_INDENT_PX}px`,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        marginBottom: '2px',
      }}
    >
      <TreeItemToggle hasChildren={hasChildren} expanded={expanded} onToggle={onToggle} />
      <TreeItemLabel project={project} />
      <TreeItemBadges agentCount={project.agentCount} templateCount={project.templateCount} />
    </div>
  );
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <TreeItemRow
        project={node.project}
        depth={depth}
        hasChildren={hasChildren}
        expanded={expanded}
        onToggle={() => setExpanded(!expanded)}
      />
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
