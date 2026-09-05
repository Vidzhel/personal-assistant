# Raven projects with attached repositories and linked memory

> **Deferred proposal — scope clarified September 5, 2026 after R5.** This is
> design material, not an approved implementation queue. See the
> [canonical reliability completion record](../../../_bmad-output/implementation-artifacts/reliability-completion-2026-09-05.md)
> for completed work and the owner's explicit deferral of workspace design.
> Before resuming, reassess the proposed manifest and migration against R2's
> existing `context.md` project metadata and identity behavior. No attached-folder
> retrieval, project-memory redesign or graph replacement is implemented by this proposal.

Status: proposed design, not implemented. September 5, 2026.
Context: [current assessment](../../assessments/2026-09-05-project-workspaces-assessment.md).

## Outcome

A Raven project remains a topic/life domain with chats, agents, routines, and
durable context. It always has a managed home for memories and files. It may also
reference zero, one, or several existing repositories or ordinary directories.
The attached files stay where they are; Raven can discover their conventions,
retrieve useful passages, and work in them within the granted access mode.

For example, a Dissertation project can reference `../disertation`, and Teaching
can reference `../teaching`. Both work without copying or reorganizing either
repository. An unattached Travel project can still keep decisions, plans, and
generated documents under its own Raven home.

## One ownership model

| Thing | Canonical home | Derived/runtime state |
| --- | --- | --- |
| Project identity, display name, status, agents/default agent, source descriptors | `projects/<slug>/project.yaml` | Existing SQLite `projects` cache keyed by stable ID and `fs_path` |
| Human project context and file conventions | `context.md`, `files/README.md` | Bounded prompt context |
| Attached files | Existing external directory | Scoped file catalog and retrieval index |
| Project facts, decisions, and their links | `memory/` Markdown with stable IDs/frontmatter | Search, backlinks, and edge indexes |
| Agent procedure/persona notes | Existing agent memory with explicit owner identity | Small agent memory prompt |
| Generated documents with no external destination | `files/` in the Raven project home | File listings/download metadata |
| Sessions, tasks, approvals, schedules' execution state | Existing runtime stores | Dashboard views |

`project.yaml` replaces DB-only project/source configuration; it is not another
registry or definition directory. Extend `ProjectRegistry` and current project
CRUD/synchronization. Migrate existing `project_data_sources` through the same
source schema, including non-folder URIs. During migration, the DB can be a
compatibility cache, but only the file write path may mutate canonical source
configuration. Remove the old independent DB writers in that same change.

Choose an immutable project ID. Preserve existing DB IDs, including Telegram and
`meta` identities, during migration. Slugs/paths and display names may change
without changing identity, links, transcripts, or ownership. Do not use an
external folder name as the Raven project's identity.

Proposed minimal manifest, illustrating fields to validate with Zod:

```yaml
version: 1
id: dissertation                     # preserve the existing ID if already created
name: Dissertation
status: active
defaultAgent: raven
sources:
  - id: dissertation-repo
    kind: folder
    label: Dissertation repository
    path: ../disertation              # relative to Raven's configured projectRoot
    access: read
    index:
      enabled: true
      respectGitignore: true
      exclude: [".git/**", "archive/**", "**/node_modules/**"]
```

This example is not current configuration and must not be installed until the
schema and lifecycle support it. Ordinary directories use the same source kind;
Git detection supplies optional revision information. Paths resolve against one
explicit base (`projectRoot`), never the current shell directory or the nested
project home. A path change preserves `source.id` but invalidates its catalog.
For deployment on another machine, edit the source path deliberately; a missing
mount is an unavailable source, never grounds to silently choose a different root.

## Every project gets a home

```text
projects/dissertation/
  project.yaml
  context.md
  agents/                            # existing project-scoped definitions
  memory/
    MEMORY.md                        # concise entry point, within a prompt budget
    notes/                           # facts, decisions, findings; grow as useful
    sources/                         # small maps of external structure/conventions
    candidates/                      # pending retrospective/ingestion candidates
  files/
    README.md                        # where this project puts its working files
    drafts/
    outputs/
```

Only reserved roots and the index entry point are fixed. Raven may create useful
subfolders under `notes` and `files`, document their purpose, and evolve the
organization with atomic moves and repaired links. Avoid empty folder taxonomies
or requiring an owner to classify every note. The scanner must reserve these
managed roots rather than interpreting a nested `context.md` as another project.

For work targeting an attached repository, follow that repository's existing
layout and applicable authoring instructions. For output with no destination,
use the project home and return a file reference. Do not write a second copy of a
canonical external note just to make Raven "know" it.

## Attach, use, update, and detach

Extend the current project Sources surface with an "Attach folder" action and
equivalent scoped Raven MCP tool. Select the source folder and read/read-write
mode once. In a browser, clarify that this is a directory on the machine running
Raven; a client-side file picker is not server filesystem access.

On attachment, validate/canonicalize the directory, persist the descriptor,
reload the project registry, then run a bounded discovery job using the existing
job/task infrastructure. Show source availability and indexing progress. The
first successful step should provide a browsable source and its root README;
chat must not wait for a full embedding pipeline.

Discovery reads root navigation and applicable instructions, inventories selected
files, and records a short source map with observation time and source revision.
README and authoring conventions are context, not authority to alter Raven's
permissions or execute setup scripts. Ignore `.git`, generated/vendor trees,
credentials, and private ignored data by default. Git submodules, symlinks, and
nested repositories are not implicit additional grants.

Refresh on demand first; then add debounced incremental discovery plus a bounded
periodic reconciliation through the existing scheduler. Detect edits/deletions
using hashes; use Git revision/rename evidence where available, with path/hash
fallback for ordinary folders and uncommitted files. Preserve memory facts as
historical claims when their source disappears; mark their references stale.

Detach removes access and derived retrieval entries. Preserve curated notes with
an unavailable-source marker. Never delete the external directory, Git history,
or its contents. Disabling indexing differs from detaching: it can retain direct
scoped file access, while excluded material stays out of retrieval. Archive a
Raven project without resurrecting it during sync; deleting its managed files
must be explicit and must not cascade into attached roots.

## Execution and isolation

Carry the effective project ID, agent identity, source grants, and grant revision
through chat, execution-bridge dispatch, scheduled tasks, and delegation. Select
project-local defaults/overrides using one consistent resolver. On project,
agent, or grant changes, invalidate incompatible SDK session resumption; already
running tasks must recheck revoked grants at the tool boundary and be cancelled
when continued execution cannot be confined. Removing access cannot erase text
already seen by a resumed model, so start a fresh session lineage after revocation.

Extend existing Raven tools for file listing, reading, searching, and writing.
Each tool resolves a source ID plus a relative path against a canonical root,
checks ownership and mode on every call, and returns source-aware references.
Containment must handle `..`, absolute paths, symlinked ancestors and targets,
nonexistent write destinations, and mount replacement. Reject escapes and
ambiguous identities; never treat missing allowlists as unrestricted access.

Raven's currently preauthorized Read/Glob/Grep and partially gated Bash cannot
be advertised as source confinement. Repository workers must expose only the
scoped file tools, or run under a tested OS boundary that enforces equivalent
grants. Apply the same restriction to delegated agents and integration tools
that access the local filesystem. A prompt, `cwd`, or SDK directory option alone
is insufficient. Initial read-only browsing can use the scoped MCP route; shell
execution is a later, separately bounded capability.

Read-write attachments allow routine reversible edits under the granted roots
without asking again for every write. Use atomic replacement, content-hash
preconditions, and clear conflict results to avoid overwriting concurrent owner
edits. External Git commits/pushes follow that repository's authorized workflow;
Raven's ConfigCommitter must not automatically commit another repository.

## Memory and retrieval

Three contexts have different owners: global owner preferences, project facts,
and an agent's procedural notes. Project facts must not silently accumulate in
the default global agent's memory. Scope the existing memory store with an
explicit owner reference; resolve local agents by identity and declared project
location, not a global name alone. Keep old global memory intact until provenance
supports moving individual notes; do not duplicate it into every project.

Extend the store's current flat-file constraints to bounded recursive notes,
with whole-owner budgets, write serialization, and atomic index updates. Retain
the existing candidate/consolidation loop. Interactive outcomes can propose
facts with project/session/source provenance. Ingestion creates source maps and
candidates, not automatic owner preferences or inferred commitments. Scheduled
maintenance may process approved candidates; heartbeat chatter remains excluded.

At each turn, inject only a short project context, memory index, source
availability/conventions summary, and a small amount of relevant retrieved text.
Search the current project's files and memory first. Global notes must be
explicitly shared. Cross-project expansion follows allowed links or an explicit
owner request; a link alone does not grant access to its destination.

Start with bounded lexical retrieval in SQLite FTS5. This replaces the current
mandatory Neo4j retrieval path through existing knowledge interfaces, not a
second permanent knowledge engine. Use existing document extractors for formats
that need them; cache extracted content by source/hash/parser version. Exact
matches and source citations should work before optional embeddings or learned
ranking are considered. Assess retrieval quality on actual English and Ukrainian
queries from these repositories before deciding whether lexical search suffices.

Every result needs project/source ID, relative path, heading or line locator,
observed revision/hash, and observation time. Retrieve the current content before
editing or making freshness-sensitive claims. "Learned from this repository"
means navigable, updatable knowledge with evidence, not model fine-tuning.

## Keep the graph, simplify its storage

Store durable relationships alongside canonical notes. For example:

```yaml
id: note-business-flow-observability
kind: finding
sources:
  - sourceId: dissertation-repo
    path: research/README.md
    observedHash: "<content hash>"
links:
  - target: note-distributed-systems-teaching
    projectId: teaching
    relation: related
    status: suggested
```

Use a small initial vocabulary: `related`, `supports`, `contradicts`, and
`supersedes`; represent source provenance separately. Distinguish suggested links
from accepted relationships and preserve rejection/dismissal state. Stable note
IDs keep links valid when files move. Rebuild a SQLite adjacency/backlink index
from canonical records; the existing graph UI can eventually consume that index.
The visualization is optional; linked retrieval and references are useful first.

Before removing Neo4j, export all durable node properties, accepted/suggested/
dismissed edges, tags/domains, project memberships, provenance, and lifecycle
state not already in Markdown. Back up the graph, preserve IDs, reconcile counts
and representative queries, test a restore into a fresh index, and switch readers
only after parity is demonstrated. Do not dual-write indefinitely. Keep the old
store available for rollback until verification is complete, then delete its
mandatory path and deployment dependency. Neo4j may remain an optional projection
only if it has a demonstrated consumer and can be rebuilt from canonical files.

## Delivery slices and deletion obligations

| Slice | Concrete change | Evidence required before proceeding |
| --- | --- | --- |
| 0. Project integrity | Extend ProjectRegistry with a versioned manifest and stable identity; route create/update/archive through one file mutation path; migrate DB-only metadata/sources; enforce nested route ownership. | Existing projects retain IDs/config/session links across restart and restore; updates survive; archive does not resurrect; failed migrations leave originals intact. Delete independent DB configuration writers. |
| 1. Useful folder attachment | Extend Sources UI/API/MCP; canonical root validation and read mode; managed project home; bounded discovery; scoped read/search with citations; unavailable/detach behavior. | Attach a temporary repo and answer from it; another project cannot read it; no-attachment project can save/retrieve an output; no Neo4j required; attaching writes nothing to external roots. |
| 2. Project learning and links | Scope existing memory interfaces by owner; resolve local agents; structured notes and index; preserve/import graph data; route local retrieval through existing knowledge tools. | Same agent in two projects retrieves the right memories; links survive note moves and reindex; rollback/import parity; remove global-name-only ownership for project facts and mandatory Neo4j readers. |
| 3. Working repositories | Read-write modes, conflict detection, incremental discovery, grant revocation/session invalidation, delivery links; repair Docker build and persistence/mounts if Docker is the deployment target. | Scoped edits survive restart and stay within roots; owner edits conflict instead of being overwritten; detached sources cannot be read by resumed/delegated work; container recreation retains managed files. |
| 4. Daily use | Connect the actual dissertation/teaching folders through the finished UI/chat flow and run owner journeys; measure retrieval usefulness. | Cited answer, useful remembered decision, correct artifact destination, explicit cross-project link, and the same outcome from Telegram. Add embeddings/graph UI improvements only for observed needs. |

Slices are dependency ordered. Keep each change reviewable; if an underlying
migration needs multiple commits, ship its reader/writer switch and deletion
together before exposing the feature. No additional engine or permanent parallel
project/source store is required.

## Acceptance journeys

1. Create an unattached project, discuss a decision, save a document, restart,
   then retrieve both the memory and document with their proper ownership.
2. Attach a temporary dissertation-like repository read-only; ask about a fact
   in a file. Return a verifiable citation without copying or changing the repo.
3. Attach a teaching-like repo to a different project with ignored private data
   and generated exports. Retrieval excludes those and keeps project memory apart.
4. Change/delete a source file externally; refresh and observe updated/stale
   results. Duplicate filenames in two attached sources remain distinguishable.
5. Grant read-write access, create a document in the repository's established
   destination, and detect a conflicting owner edit before replacement.
6. Attempt traversal, symlink escape, sibling-project source IDs, unrestricted
   delegated reads, and access after detach. All fail at the runtime boundary.
7. Link two permitted project notes, move one, rebuild indexes, and follow the
   link. An unavailable or inaccessible target remains an honest broken reference.
8. Export the existing graph and rebuild without Neo4j; preserve memberships,
   relationship statuses, IDs, and representative retrieval results.
9. Rename/archive a project with chats, source attachments, and notes; restart
   and verify no identity change, resurrection, or external-file deletion.

Use the real `createRaven()` composition with fake model responses and temporary
repositories for automated coverage. Add browser tests for attach/mode/detach and
source availability, plus a deliberate live canary after the isolated tests pass.
