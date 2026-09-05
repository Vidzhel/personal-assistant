# Raven: progress, architecture, and project workspaces

> **Assessment snapshot — reconciled September 5, 2026 after R5.** This review
> predates the reliability changes. Its original findings remain below; current
> status and verification evidence are in the
> [canonical reliability completion record](../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md).
> R0–R5 addressed the current project lifecycle, capability, deployment and UI
> reliability gaps. Repository attachments and project-memory redesign remain
> deferred proposals, and isolated tests do not establish live account delivery.

Reviewed September 5, 2026 against commit `e7e0ed5` and the existing working tree.
This is an assessment and proposed next scope, not a claim that repository
attachments have been implemented. The companion
[design and delivery plan](../superpowers/specs/2026-09-05-project-workspaces-design.md)
defines that work. It updates the conclusions of the
[August 6 assessment](2026-08-06-architecture-assessment.md) without rewriting history.

## Judgment against the philosophy

The project has made substantial progress. Keep the current architecture and
finish its project boundary. A persistent Raven project that can work with zero
or more external repositories fits the original purpose: context without manual
copying, useful memory, low coordination overhead, and autonomy enforced by code.
It should extend the existing project registry, memory store, knowledge tools,
and scaffold-and-activate flow. It does not warrant a new agent framework,
workspace engine, or workflow language.

The strongest decisions remain the typed event contract across channels, explicit
capabilities, a small gateway around SDK execution, versionable definitions,
and deterministic schedules/intents. The main remaining architectural mismatch
is ownership: project metadata is split between files and SQLite; memories are
owned by global agent names; knowledge relationships depend on Neo4j; attached
file sources are metadata rather than working context.

The original PRD describes a single-user assistant that reduces fragmentation,
delegates reasoning to an existing execution engine, and enforces permissions in
code. Those principles are more useful design tests than its old subsystem names
or the March sprint tracker. A folder attachment is valuable when Raven can
answer from the right files, cite them, remember a decision in the right project,
and put a resulting document somewhere predictable.

## What was completed after the August review

These are implementation findings; live owner-account behavior was not exercised.

| Area | Current evidence | Assessment |
| --- | --- | --- |
| Runtime and continuity | `f54efd3`, `78a578d`, `f7db8be`; `agent-manager/sdk-backend.ts`, `agent-session.ts` | SDK-only execution, persisted session IDs, resume, and serialized chat turns landed. The old CLI backend and custom compaction were deleted. |
| Task lifecycle | `f9ca078`, `1d9f711`; `task-execution/execution-bridge.ts` | Raven MCP is wired and runtime completion advances task trees, independently of model cooperation. |
| Consolidation | `c7dfa25`, `1d37c85`, `d9b9eca`; `services/registry.ts` | Old pipelines, suites, and duplicate capability infrastructure were removed; services compile in core. |
| Capabilities and enforcement | `607e31b`, `0a667e9`, `77feb80`; `agent-registry/agent-resolver.ts`, `permission-engine/tool-policy.ts` | Empty skills mean none; actions resolve through the library; pre-execution policy and a dashboard approvals inbox exist. Filesystem confinement remains incomplete. |
| Project creation | `f72e0ba`, `f8db9bc`; `project-manager/project-sync.ts`, `api/routes/projects.ts` | Web/Telegram creation scaffolds directories and links DB rows by `fs_path`; legacy reconciliation preserves referenced data. This is not yet a fully file-owned project lifecycle. |
| Learning | `3d8b614`; `session-manager/session-retrospective.ts`, `agent-memory/` | Interactive retrospectives can write candidates and consolidation promotes memory without Neo4j. This is agent memory, not isolated project memory. |
| Extension and proactivity | `6c90e1c`, `2ad5071`, `72b853d`, `c6c530f` | Skills, agents, templates, and schedules can be scaffolded and activated from chat. Intents have budgets/cooldowns/expiry; heartbeat is off by default with a silence contract. |
| Verification | `20486fe`, `1ef8328`, `c8af56b`; `.github/workflows/ci.yml`, real-composition E2E tests | CI, boot/chat/schedule tests, deterministic self-tests, and a weekly canary exist. Readiness still needs verification in the actual deployment. |

Phases 0–4 were substantially implemented. Remaining items should be tracked as
specific gaps, rather than restarting those phases. Phase 5—using real life
domains and measuring usefulness—is the right direction for the next increment.
The March sprint tracker still calls deleted pipelines complete and is historical.

## Findings that affect the next change

### 1. High: project updates and deletion do not honor file ownership

`api/routes/projects.ts` PUT updates SQLite only. DELETE removes a DB row while
leaving the directory; `project-manager/project-sync.ts::syncFromRegistry` will
rediscover that directory on boot. A renamed display name can also be replaced
by the directory-derived name during sync. Deletion with referenced sessions or
data sources can fail foreign-key checks.

`scaffolding/scaffolding-api.ts::createProject` writes only `context.md`;
`project-registry/project-scanner.ts` derives the name from the folder and sets
`systemAccess: 'none'`. Display name, access policy, description, skills, and
system prompt therefore do not all have a restorable canonical file.

Finish metadata persistence, stable identity, and archive/delete semantics before
making attachment configuration depend on this lifecycle. Add restart and
restore tests, not just create-and-chat coverage.

### 2. High: local data sources are not repository integration

`project-manager/project-data-sources.ts` stores URI/label/type in SQLite.
`buildProjectDataSourcesContext` has no production caller. Chat builds its
context from registry `context.md` files and does not resolve attached source
roots, scan them, enforce modes, or retrieve their contents.

The nested data-source PUT/DELETE routes in `api/routes/project-knowledge.ts`
also fail to verify that `dsId` belongs to the route's project ID. An attachment
implementation must close this ownership mismatch rather than inherit it.
Extend and migrate this existing source concept; do not leave competing source
and repository lists in the UI or in separate stores.

### 3. High: project-local agents and project memory are not resolved as such

`orchestrator/orchestrator.ts::handleUserChat` always selects `getDefaultAgent()`.
It consumes the inherited context text but not the inherited agent map returned
by `ProjectRegistry.resolveProjectContext`. `yaml-named-agent-store.ts` indexes
by name with global agents winning collisions, whereas the project registry's
ancestor resolution permits child overrides.

`agent-memory/memory-store.ts::resolveMemoryDir` always returns
`projects/agents/<name>/memory`; `agent-session.ts` injects that memory using only
`task.namedAgentId`. The same default agent consequently shares memory across
projects. A local agent's declared folder is not its memory root. The store also
forbids nested note paths. Project ownership, agent identity, and folder layout
need to agree before learning from dissertation and teaching documents.

### 4. High: the existing tool policy is not an attachment access boundary

`agent-session.ts` preauthorizes Read/Glob/Grep; `tool-policy.ts` has no
project/source-root context and checks writing tools against raw path strings.
Its own documented probes say `canUseTool` sees only Bash commands the SDK
decides require permission. Setting `cwd`, listing paths in a prompt, or adding
`allowedPaths` therefore does not establish complete read/write confinement.

Use source-scoped tools with canonical path checks and a constrained execution
surface for repository work. Reversible edits should follow the mode granted on
attachment; destructive work keeps Raven's existing approval contract. Verify
the boundary for delegated work and resumed sessions as well as direct calls.

### 5. High: graph deletion would currently lose relationships

Knowledge bodies already have Markdown copies in `data/knowledge`, but
`knowledge-engine/knowledge-file.ts::BubbleFrontmatter` has no link or project
membership fields. `link-ops.ts` writes `LINKS_TO` to Neo4j and
`project-knowledge.ts` writes `BELONGS_TO_PROJECT` there. Reindexing Markdown
cannot reconstruct these relationships or all durable graph metadata.

The August advice to reduce infrastructure is sensible; its categorical advice
against graphs is too broad for this new requirement. A graph is a useful model
for source references, related ideas, contradictions, and decisions. It need not
mean a mandatory graph server. Keep durable links in files and derive a small
SQLite edge index; retain Neo4j until a verified export preserves its data. A
graph view can consume those edges. Reconsider Neo4j only if measured traversal
or scale requirements justify maintaining it.

### 6. Medium: knowledge availability and agent instructions still disagree

`raven.ts` constructs and discards `_contextInjector`. Direct Raven knowledge
tools now exist, so this is not the original entirely severed memory loop, but
automatic context retrieval remains absent. Chat unconditionally adds the
`knowledge-agent`, whose definition still has `tools: []` while naming knowledge
tools in its prompt. This does not establish a usable specialist tool contract,
particularly when the knowledge engine is unavailable.

Expose only available retrieval capabilities, prove them through a real SDK
boundary, and make local file retrieval work without Neo4j. Do not make successful
project chat depend on every indexing/embedding component booting.

### 7. High for deployment: Docker still targets deleted paths

`Dockerfile.core` copies nonexistent `packages/skills/`, omits current runtime
definition/migration inputs, and does not represent the current workspace layout.
`docker-compose.yml` still requires healthy Neo4j before starting core and mounts
only `data` and `config`; versioned `projects`/`library` changes would not be
persisted through those bind mounts. No sibling repository mounts exist.

Repair and exercise the actual image before using Docker for attached folders.
Application-level graceful degradation does not make Compose's dependency optional.

### 8. Medium: development instructions lag behind the implementation

`CLAUDE.md` still describes suites and empty-skills-as-all. This pass adds a current
Codex entry point and corrects corresponding current-state architecture text.
Claude's source setup is preserved. Use the dated assessment as the shared status
reference, and eventually consolidate development guidance so these descriptions
cannot drift independently.

### 9. High: default tests assumed the owner's Neo4j was absent (fixed here)

The composition tests supplied literal local Neo4j connection settings, so the
environment credential guard did not isolate them. After local socket access was
enabled, test logs showed successful schema/project synchronization against the
running local graph; the boot test failed because knowledge was available.

This pass adds a default-suite-only mock at the Neo4j client factory boundary in
`__tests__/setup/neo4j-guard.ts`. It rejects real client creation before any network
operation. The separate opt-in knowledge project still uses testcontainers.
No graph cleanup was attempted because pre-existing records cannot safely be
distinguished from test effects without a prior snapshot. This incident reinforces
the need to isolate external state, not only credentials and local test files.

## Repository inspection and fit

Read-only inspection of the two root READMEs confirms the requested examples are
available as `../disertation` and `../teaching`. No sibling repository was modified.

- Dissertation already has `writing`, `literature` (an Obsidian/Zettelkasten vault),
  `research`, `references`, `artifacts`, and `evaluation`. Preserve its existing
  links and citation identities; do not create another copy of the literature
  vault inside Raven. Bibliography exports and archived snapshots have their own
  ownership rules.
- Teaching makes Markdown canonical, treats `exports/` as generated, and keeps
  grades/submissions in ignored `_local/`. Default indexing should honor ignores
  and exclude generated exports. Linking this repository must not imply that
  local student records become global assistant memory.

Raven's own project home is the place for assistant summaries, decisions, source
maps, and output with no external destination. Documents belonging to a connected
repository should follow its local conventions when write access is enabled.
An attachment provides access and a retrieval source; learning means curated,
provenanced notes—not model training or a one-time summary treated as permanently
current.

## Next scope

1. Finish project lifecycle and scope identity, including source ownership checks.
2. Attach a folder through the existing source flow; resolve scoped reads and
   basic retrieval, with a useful no-attachment project home from the start.
3. Add project memory and structured outputs using the existing memory/knowledge
   interfaces; keep global preferences explicit and cross-project links deliberate.
4. Export and preserve graph relationships, then replace mandatory graph-backed
   retrieval with local indexes. Add incremental indexing and scoped writes.
5. Run the dissertation and teaching journeys from chat, then from Telegram,
   before adding another engine or redesigning routines around an SDK feature.

Do not switch Raven's runtime to Codex as part of making this repository editable
with Codex. A second runtime provider would require separate parity tests for
resume, delegation, MCP scope, permissions, cancellation, and streaming. It is
not necessary for the owner's requested development compatibility.

## Verification

Results and the Codex migration record are documented in
[the verification record](2026-09-05-codex-verification.md). Automated tests here
use fake model boundaries; they do not prove production Claude authentication,
Telegram delivery, repository access, or live Neo4j compatibility.
