# M0 session model controls — review record

Date: 2026-09-06. Parent review plus independent blind, edge-case and acceptance
reviews. Implementation follows the existing SDK, session store, workspace YAML,
AgentManager queue and budget admission; it adds no second model runtime.

## Findings and resolution

- Persisted effort/thinking could fail after restart until someone opened the
  model selector. Added lazy zero-prompt discovery before settings validation,
  including explicit IDs, named agents and resolved nested-worker controls.
- A model switch queued behind an active turn captured history too early. Added a
  bounded execution-time handoff with a current-message cutoff and predecessor
  task IDs. Composed tests prove the preceding answer is included, current input
  appears once and later queued input is excluded.
- Catalog aliases could validate one model and execute another. Effective settings
  now use the reported canonical ID, shared by task history, backend and budget.
- Background execution lacked catalog/nested-effort validation. It now captures
  validated parent and child settings before dispatch and suppresses dispatch when
  stopped during discovery.
- HTTP/WS preflight without a session ID differed from actual active-session
  selection. Both now use the same read-only selection as the orchestrator.
- Cancelled cold starts could save an uncertain SDK lineage. They no longer do;
  cancellation regression verifies an observed initialization ID is not persisted.
- Catalog synchronous throws and late stop completion could leave stale lifecycle
  state. Cleanup and stop ownership now cover those paths. Bearer credential
  redaction covers the complete authorization value.
- Model editing showed misleading inheritance/default labels and stale discovery
  copy. It now shows effective inheritance and cached evidence, isolates drafts by
  project/session, and refreshes effective projections after discovery.
- Raven create/update-agent and create-skill tools retained closed model enums.
  They now accept the shared validated model ID schema.
- Telegram command coverage was too shallow. Bot-level tests now cover routing,
  reply-bound sessions, authorization suffixes, set/reset, missing-session behavior,
  metadata errors, and project/session changes while discovery is pending.
- Concurrent workspace responses could combine one saved config with another
  request's effective model. Projection now uses the returned saved override.

## Reviewed boundaries

The HTTP `queued` receipt precedes orchestrator admission. Model snapshots freeze
at `user:chat:accepted` / task queue admission; changes before that point are
current owner choices. Same-session execution is already serialized, so the blind
review's concurrent SDK-lineage overwrite hypothesis does not apply to that path.
The blind patch omitted SQL from its input; the actual initial schema includes
`model_config_json` and version 3, exercised by persistence and restart tests.

Definition files and agent CRUD accept syntactically valid explicit IDs without
requiring account availability while authoring. Dispatch validates current catalog
support; storing an unavailable model does not grant execution or silently fall
back. Preset defaults remain usable when catalog discovery is unavailable. SDK
catalog metadata is capability evidence, not proof of entitlement. A live Fable
account check remains an operator canary, outside fake-provider verification.

## Verification

Final checks and build results are recorded in the completed specification. All
verification uses temporary projects and fake providers; the real SDK contract
uses a fake executable and verifies initialization without a user prompt plus
subprocess EOF/abort cleanup. No live account delivery or inference is claimed.
