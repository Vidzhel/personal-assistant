---
title: Session model and thinking controls
type: feature
created: 2026-09-06
status: draft
context:
  - ../../AGENTS.md
  - ../../ARCHITECTURE.md
  - personal-assistant-next-steps-2026-09-06.md
---

# Session model and thinking controls

## Intent

The owner approved model/thinking controls as the second P0 product priority.
Permit deliberate stronger reasoning for dissertation work and cheaper models
elsewhere, including switching for the next turn of the same Raven conversation.
Use the installed Claude Agent SDK; retain existing permission and budget checks.
Implement after the Telegram project/session slice and before remote readiness.

## Boundaries

Configuration precedence is turn → session → project → named agent → installation.
Retain friendly aliases, accept explicit validated model IDs, and validate effort
and thinking against reported capabilities plus documented mandatory-thinking
rules. Do not silently substitute a cheaper model. SDK discovery is not proof of
account entitlement or a successful inference; actual provider rejection remains
visible. Live switching within an already-running response is out of scope.

Do not import provider SDK types into shared. Persist user choices and snapshot
the resolved settings when admitting a turn. Queued/active work keeps that snapshot
after settings change. Preserve budget admission, workspace revocation, scoped
MCPs, nested-agent scope, internal validators and truthful completion history.
No model calls or owner transcript access during verification.

Session patches use absent = unchanged and `null` = reset; a supplied config
replaces the override atomically and is validated as a whole. Support provider
default (omitted), adaptive and disabled thinking initially; fixed legacy token
budgets are not a promised control in this slice. Explicit settings require
matching metadata; omission preserves provider defaults. Centralize documented
mandatory-thinking rules by normalized model family instead of guessing from
descriptions. SDK-reported models are not labeled as verified entitlements.

The September 6 source check confirms `claude-fable-5-1` uses adaptive thinking
without an off mode; steer its depth through supported effort values. Keep this
policy separate from account discovery and attach its documentation/version to
the implementation. [Fable 5.1 model documentation](https://platform.claude.com/docs/en/models/fable-5-1/overview).

Use a bounded in-memory catalog cache with fetched time, revision and stale/error
state; restart can rediscover without inference. Persist owner selections, not
credentials or account metadata. Apply session overrides to conversational turns;
approved actions, heartbeats and internal validators retain their existing
dispatch authority/defaults. For nested agents, explicit child model/effort wins;
inherit parent effort only with an inherited model and validated support, avoiding
unsupported high-effort settings on cheap workers. Preserve this field through
workspace-context wrapping. Reserve budget using the captured canonical model ID.

## Discovery evidence

The installed SDK exposes `supportedModels()` on Query, not a standalone catalog.
A parent experiment using an async input iterator that emits no user messages,
empty tools/MCPs/settings sources, temporary cwd and a fake executable successfully
returned models from the initialization control response. Recorded protocol:
`control_request: initialize` only; no user/model prompt was emitted. The restricted
runner closed the subprocess; normal execution passed. Convert this experiment
into a real subprocess contract fixture for the implementation.

Use bounded cached discovery with cancellation/timeout and guaranteed Query/input
cleanup. No production request is necessary to populate the selector. Discovery
failure leaves an actionable unavailable/stale state; existing default operation
must not depend on a successful new paid query. Never expose account credentials.

## Code map and execution

- [ ] `packages/shared/src/types/agents.ts`, project/library schemas and related
      types: shared model-choice/config schemas with open IDs, effort/thinking choices,
      preset aliases and reset semantics. Remove closed-enum coupling in current
      consumers rather than updating only a UI selector.
- [ ] `packages/core/src/agent-registry/agent-resolver.ts` and model catalog module:
      normalize alias/resolved IDs and config, discover/cache capabilities, validate
      supported combinations and select deliberate defaults.
- [ ] `migrations/001-initial-schema.sql`, SessionManager and session API:
      persist nullable structured model config and validate patches. Project defaults
      belong in `project.yaml` and its existing workspace update lifecycle.
- [ ] `packages/core/src/orchestrator/orchestrator.ts`, chat API/WS contracts and
      AgentManager admission: resolve the owned
      session first, then model config; capture choices and bounded historical handoff
      without creating mutations for a rejected cross-project or invalid-model input.
- [ ] AgentTask/event types, `workspace-task.ts`, `execution-run-records.ts`:
      snapshot model/effort/thinking in queued work, revision checks and run history.
- [ ] `agent-backend.ts`, `sdk-backend.ts`, `agent-session.ts`: forward optional
      effort/thinking, retain unchanged-config SDK resume, use a bounded source-linked
      historical handoff on cold continuation. Keep the canonical current prompt
      separate from synthetic history. Reject stale grants exactly as before.
- [ ] Browser composer/session/project settings and Telegram `/model` command:
      display effective model and effort, apply settings to subsequent turns, surface
      validation failures and discovery state. Preserve the selected Raven session.
- [ ] Regression tests across schema, resolver, sessions, queued dispatch, SDK
      subprocess, budget/resume and browser controls; update guidance and evidence.

## Handoff design

Raven's transcript survives independently of the provider session. Changing model
configuration invalidates the SDK resume revision. Snapshot a bounded selection
of prior user/assistant messages with message IDs at admission, excluding the
current input, and delimit it as untrusted historical context. Use it only for a
cold continuation; unchanged settings should keep normal resume. Do not load
another project's messages or blindly concatenate an unbounded transcript.
Capture history before appending the current input, or use an explicit message
cutoff. Validate model/session ownership before transcript/status mutation.
Keep a discernible matched/changed/missing resume result so a revoked workspace
can never be treated as permission to cold-start with history.

## Acceptance

| Given                                             | When                                   | Then                                                                    |
| ------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Earlier distinctive fact in session               | Model is changed and next message sent | Same Raven conversation retains the fact; new SDK lineage is allowed    |
| Unchanged config                                  | Next turn runs                         | Existing safe SDK resume remains in use                                 |
| Queued turn                                       | Session setting changes                | Queued turn keeps captured config and budget model                      |
| Unsupported effort or disabled mandatory thinking | Setting/run submitted                  | Reject clearly before model work                                        |
| Project/session/turn overrides                    | Turn admitted                          | Documented precedence determines one consistent config                  |
| Worker delegation                                 | Task runs                              | Intended worker defaults and scope survive; actual model is inspectable |
| Stale workspace/capability revision               | Queued work starts or tool runs        | Existing revocation behavior still blocks                               |
| Catalog timeout/auth failure                      | Selector opens                         | Visible unavailable/stale state; no hidden inference or downgrade       |

## Verification

Use focused resolver/options/session/resume/budget tests, a real SDK fake-executable
zero-prompt discovery contract, browser-testing skill with isolated model fixtures,
required `npm run check`, default suite, core production build and compiled restart.
Test unsupported settings through HTTP and WS as well as pure schemas. A live
Fable entitlement check remains separate; do not represent fake-model success as
account availability. Parent reviews, commits and pushes the completed slice.
