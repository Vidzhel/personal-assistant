/**
 * Manual TickTick MCP integration test script.
 * Exercises: list projects, list tasks, create/update/reschedule/delete a task.
 *
 * Usage: npm run test:ticktick
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectMcp, callMcpTool, closeMcp } from './skill-tests/mcp-tester.ts';
import type { McpConnection } from './skill-tests/mcp-tester.ts';

// ── Load .env manually (no dotenv dependency) ──────────────────────────────

function loadEnv(): void {
  const envPath = resolve(import.meta.dirname ?? '.', '..', '.env');
  let content: string;
  try {
    content = readFileSync(envPath, 'utf-8');
  } catch {
    console.error(`Could not read ${envPath}`);
    process.exit(1);
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseToolResult(result: { content: unknown; error?: string }): unknown {
  if (result.error) {
    throw new Error(`MCP tool error: ${result.error}`);
  }
  const content = result.content as Array<{ type: string; text?: string }>;
  if (!Array.isArray(content) || content.length === 0) {
    throw new Error('Empty MCP response');
  }
  const textPart = content.find((c) => c.type === 'text');
  if (!textPart?.text) {
    throw new Error('No text content in MCP response');
  }
  return JSON.parse(textPart.text);
}

function formatDate(daysFromNow: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0]!;
}

function step(label: string): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`▶ ${label}`);
  console.log('─'.repeat(60));
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv();

  const token = process.env.TICKTICK_ACCESS_TOKEN;
  if (!token) {
    console.error('TICKTICK_ACCESS_TOKEN not set. Check .env file.');
    process.exit(1);
  }

  console.log('🔌 Connecting to TickTick MCP server...');

  const conn: McpConnection = await connectMcp({
    command: 'node',
    args: ['--experimental-strip-types', 'packages/mcp-ticktick/src/index.ts'],
    env: {
      TICKTICK_ACCESS_TOKEN: token,
      TICKTICK_CLIENT_ID: process.env.TICKTICK_CLIENT_ID ?? '',
      TICKTICK_CLIENT_SECRET: process.env.TICKTICK_CLIENT_SECRET ?? '',
    },
  });

  console.log(`✅ Connected. Available tools: ${conn.tools.join(', ')}`);

  let createdTaskId: string | undefined;
  let createdProjectId: string | undefined;
  const summary: string[] = [];

  try {
    // ── 1. List projects ──────────────────────────────────────────────────
    step('List projects');
    const projectsRaw = await callMcpTool(conn, 'get_projects');
    const projects = parseToolResult(projectsRaw) as Array<{ id: string; name: string }>;
    console.log(`Found ${projects.length} projects:`);
    for (const p of projects) {
      console.log(`  • ${p.name} (${p.id})`);
    }
    summary.push(`Listed ${projects.length} projects`);

    if (projects.length === 0) {
      console.error('No projects found — cannot continue without a project.');
      return;
    }

    const targetProject = projects[0]!;
    createdProjectId = targetProject.id;
    console.log(`\nUsing project: "${targetProject.name}" (${targetProject.id})`);

    // ── 2. List tasks in first project ──────────────────────────────────
    step(`List tasks in "${targetProject.name}"`);
    const tasksRaw = await callMcpTool(conn, 'get_project_tasks', { projectId: targetProject.id });
    const tasksData = parseToolResult(tasksRaw) as { tasks: Array<{ id: string; title: string }> };
    const tasks = tasksData.tasks ?? [];
    console.log(`Found ${tasks.length} tasks:`);
    for (const t of tasks.slice(0, 10)) {
      console.log(`  • ${t.title} (${t.id})`);
    }
    if (tasks.length > 10) console.log(`  ... and ${tasks.length - 10} more`);
    summary.push(`Listed ${tasks.length} tasks in "${targetProject.name}"`);

    // ── 3. Create a task ────────────────────────────────────────────────
    step('Create test task');
    const dueDate = formatDate(1);
    console.log(`Creating "Raven test task" due ${dueDate}, priority=medium(3)...`);
    const createRaw = await callMcpTool(conn, 'create_task', {
      title: 'Raven test task',
      projectId: targetProject.id,
      dueDate,
      priority: 3,
    });
    const created = parseToolResult(createRaw) as { id: string; title: string; dueDate?: string };
    createdTaskId = created.id;
    console.log(`✅ Created task: "${created.title}" (${created.id})`);
    summary.push(`Created task "${created.title}" (${created.id})`);

    // ── 4. Update the task ──────────────────────────────────────────────
    step('Update test task');
    console.log('Updating title and adding tag...');
    const updateRaw = await callMcpTool(conn, 'update_task', {
      projectId: targetProject.id,
      taskId: createdTaskId,
      title: 'Raven test task (updated)',
      tags: ['raven-test'],
    });
    const updated = parseToolResult(updateRaw) as { id: string; title: string; tags?: string[] };
    console.log(`✅ Updated: "${updated.title}", tags: ${JSON.stringify(updated.tags ?? [])}`);
    summary.push(`Updated task to "${updated.title}"`);

    // ── 5. Reschedule the task ──────────────────────────────────────────
    step('Reschedule test task');
    const newDueDate = formatDate(3);
    console.log(`Rescheduling to ${newDueDate}...`);
    const reschedRaw = await callMcpTool(conn, 'update_task', {
      projectId: targetProject.id,
      taskId: createdTaskId,
      dueDate: newDueDate,
    });
    const rescheduled = parseToolResult(reschedRaw) as { id: string; dueDate?: string };
    console.log(`✅ Rescheduled task ${rescheduled.id}, new due: ${rescheduled.dueDate ?? newDueDate}`);
    summary.push(`Rescheduled to ${newDueDate}`);

    // ── 6. Delete (cleanup) ─────────────────────────────────────────────
    step('Delete test task (cleanup)');
    console.log(`Deleting task ${createdTaskId}...`);
    await callMcpTool(conn, 'delete_task', {
      projectId: targetProject.id,
      taskId: createdTaskId,
    });
    console.log('✅ Deleted.');
    summary.push('Deleted test task (cleanup)');
    createdTaskId = undefined; // already cleaned up
  } catch (err) {
    console.error(`\n❌ Error: ${err instanceof Error ? err.message : String(err)}`);

    // Attempt cleanup if we created a task
    if (createdTaskId && createdProjectId) {
      console.log('\nAttempting cleanup of created task...');
      try {
        await callMcpTool(conn, 'delete_task', {
          projectId: createdProjectId,
          taskId: createdTaskId,
        });
        console.log('✅ Cleanup successful.');
      } catch (cleanupErr) {
        console.error(`Cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`);
      }
    }
  } finally {
    await closeMcp(conn);
    console.log('\n🔌 MCP connection closed.');
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(60)}`);
  console.log('Summary:');
  for (const s of summary) {
    console.log(`  ✓ ${s}`);
  }
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
