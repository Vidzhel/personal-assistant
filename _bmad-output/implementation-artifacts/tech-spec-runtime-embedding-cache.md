---
title: 'Persist the Runtime Embedding Model Cache'
type: 'bugfix'
created: '2026-09-06'
status: 'done'
baseline_commit: 'abb4ebf99dde176a642528b97e8079ae68148b77'
context:
  - 'AGENTS.md'
  - 'ARCHITECTURE.md'
  - 'docs/deployment.md'
---

# Persist the Runtime Embedding Model Cache

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Runtime knowledge search can ask Transformers.js to create its default cache under `/app/node_modules/@huggingface/transformers/.cache`. The production core image runs as an unprivileged user, so the model download fails with `EACCES` and semantic knowledge search remains unavailable.

**Approach:** Give every knowledge component that shares the embedding pipeline the same explicit cache directory under Raven's existing data root. Create that directory during composition so it is writable before model loading and persists through the existing Docker data volume.

## Boundaries & Constraints

**Always:** Resolve the cache from the composed runtime data root; configure the actual Transformers.js pipeline load; share one path across bubble embeddings, chunk embeddings, and query embeddings; create the directory recursively; preserve the current lazy model load and pipeline singleton; test with temporary paths and a mocked model dependency.

**Ask First:** Any new volume, new configurable public setting, model change, eager download, or migration of an existing cache.

**Never:** Write into `node_modules`; use owner credentials or the live runtime in tests; add a second embedding pipeline; change graph data, model configuration, or integration files.

## I/O & Edge-Case Matrix

| Scenario             | Input / State                                                         | Expected Output / Behavior                                           | Error Handling                                                                         |
| -------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Docker runtime       | Data root is `/app` and `/app/data` is the persistent writable volume | Pipeline receives a cache path below `/app/data`                     | Directory creation failure aborts normal runtime composition with the filesystem error |
| Isolated composition | Test runtime uses a temporary data root                               | All three knowledge engines receive the same temporary cache path    | No access to the repository or owner cache                                             |
| Direct library use   | A caller does not provide a cache path                                | Existing Transformers.js default remains available for compatibility | No new failure before model loading                                                    |

</frozen-after-approval>

## Code Map

- `packages/core/src/raven.ts` -- derives and creates runtime-owned data paths.
- `packages/core/src/knowledge-engine/initialize-knowledge.ts` -- distributes shared dependencies to knowledge engines.
- `packages/core/src/knowledge-engine/embeddings.ts` -- owns the singleton Transformers.js pipeline.
- `packages/core/src/knowledge-engine/chunking.ts` -- generates document chunk embeddings.
- `packages/core/src/knowledge-engine/retrieval.ts` -- generates semantic query embeddings.
- `packages/core/src/__tests__/knowledge-startup.test.ts` -- isolated knowledge composition coverage.
- `packages/core/src/__tests__/embedding-cache.test.ts` -- mocked pipeline option coverage.
- `docs/deployment.md` -- documents persistent volume contents.

## Tasks & Acceptance

**Execution:**

- [x] `packages/core/src/raven.ts` -- create a cache directory below `data/` and pass it into knowledge composition.
- [x] `packages/core/src/knowledge-engine/{initialize-knowledge,embeddings,chunking,retrieval}.ts` -- thread the cache dependency to each lazy pipeline caller and pass it as the Transformers.js `cache_dir` option.
- [x] `packages/core/src/__tests__/{embedding-cache,knowledge-startup}.test.ts` -- verify the pipeline option and shared dependency propagation with temporary paths.
- [x] `docs/deployment.md` -- identify embedding models as contents of the existing `raven_data` volume.

**Acceptance Criteria:**

- Given Raven runs in the core container, when semantic indexing or search first loads BGE, then Transformers.js writes below `/app/data` and never attempts a cache mkdir below `/app/node_modules`.
- Given the process restarts with the same `raven_data` volume, when the pipeline loads again, then it can reuse the persisted model cache.
- Given embedding, chunking, and retrieval engines share a runtime, when any one loads the singleton pipeline first, then it supplies the same cache directory.

## Spec Change Log

## Verification

**Commands:**

- `npx vitest run packages/core/src/__tests__/embedding-cache.test.ts packages/core/src/__tests__/knowledge-startup.test.ts` -- passed: 2 files and 19 tests using a mocked Transformers.js pipeline and isolated dependency propagation; no Docker, network, or model download was exercised.
- Parent verification: `npm run check` passed; the full default suite passed 2,676 tests across 267 files. The actual core Docker image built successfully.
- A fresh container running as the normal image user downloaded the public BGE model into `/app/data/models/transformers` and generated a finite 384-value embedding from generic canary text. A second container with networking disabled loaded that persisted cache and generated another 384-value embedding. No owner text, provider account, or graph mutation was used in either canary.
