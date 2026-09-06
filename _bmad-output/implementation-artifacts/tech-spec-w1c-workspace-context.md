---
title: Current project instructions and repository workflow context
status: complete
baseline: 1a7089d
date: 2026-09-06
---

# Current project instructions and repository workflow context

Workspace execution is operational. Agents now need a useful, bounded explanation
of the managed home, working repository and authoritative instructions. They must
follow each repository's existing layout and tools, and may reorganize ordinary
working folders while Raven's small set of anchors retains its meaning.

## Contract and implementation

- Extend the existing workspace resolver/session prompt path with current ancestor
  `context.md` bodies and configured project instructions, read through the bounded
  file reader. Chat and execution tasks receive the same current context. Do not
  revive a second cached context authority or inject stale dispatch context over
  current files. Session/grant revisions already track these source bytes.
- Add `project-manager/workspace-context.ts` for a bounded workspace overview:
  managed home, selected cwd, execution mode and labeled sources. Link explicit
  `contextFiles`, or a small set of existing root instruction/index filenames when
  none are configured. Use filename checks only; no recursive repository crawl,
  file-body ingestion, repository embedding pipeline or generated fixed taxonomy.
  Report missing pointers and omitted entries truthfully; always retain home/cwd.
- Keep repository pipelines local. Update existing PDF, DOCX, PPTX, XLSX, media and
  transcription runtime instructions to select project-owned output paths using
  the repository's conventions. Add a reusable `repository-work` capability and
  bind it explicitly to Raven's shipped default agent. Custom agents with empty
  bindings still have no library capabilities.
- Nested managed projects require `context.md` and an explicit `project.yaml`.
  Direct top-level source projects retain optional workspace manifests. Do not
  recursively interpret arbitrary unmarked working directories as projects. A
  marked nested project with a broken/missing anchor remains a diagnostic. New
  project creation already produces both anchors; no legacy migration is needed.
- Keep agent-first sibling repository observations generic in this public repo:
  index files, Quarto/Pandoc, uv/notebooks, existing export/transcription/scripts
  and ordinary Git workflows. Do not copy scientific/student content or private
  project-specific instructions into Raven.

## Acceptance and verification

- Given manually updated project context before a turn, chat and execution use
  current instructions and maintain project isolation without registry reload.
- Given configured repository context paths or conventional root indexes, the
  prompt contains bounded usable links, reports missing links and contains no
  repository file bodies. Unrelated files and nested arbitrary content are not
  crawled. Filenames containing spaces, Unicode or Markdown delimiters remain safe.
- Given arbitrary working folders containing `context.md`, registry reload leaves
  them as ordinary files. Explicit nested project anchors are indexed; malformed
  pairs produce diagnostics and can be repaired.
- Given a document/media task, the runtime capability instructions follow local
  pipelines and project output conventions and report actual artifact paths.
- Parent review, targeted behavior tests, definition validators, required check,
  default regression, production core build, compiled restart and browser journeys
  must pass before commit/push. W1d then adds browser workspace/artifact controls
  and explicit graph project selection/filtering; W1e verifies deployment.

## Review and evidence

Parent review removed the cached chat-only context producer and unused source
formatter, explicitly propagated current context into SDK skill-agent prompts,
and capped inherited instructions at 64 KiB. Overview review fixed unbounded
source inspection before truncation, Unicode byte budgeting, malformed Markdown
links, symlinked index parents, missing/excess pointer reporting, and large selected
source sections. Scanner review replaced unbounded context reads with bounded
regular-file reads and made missing marked anchors diagnostic at every depth.
Runtime skills now follow repository output conventions and necessary authorized
in-place edits, commands and Git work. The transcription skill no longer claims
a subprocess can emit into Raven's live EventBus; a concrete managed project
transcription integration follow-up is in the deferred ledger.

Verification on September 6:

- Required `npm run check` and both definition validators pass.
- Default suite: **239 files, 2,443 passed, six explicit live-provider skips**.
  The first run exposed four nested-project fixture failures. Intended nested
  fixtures now contain explicit manifests; the complete rerun passes.
- Runtime integration covers manual context edits without reload, separate project
  prompts, delegated-agent context/tools, and cold/continued SDK session lineage.
  Scanner and overview tests cover ordinary folders, explicit nested anchors,
  malformed/symlinked/oversized context, Unicode/path syntax and bounded pointers.
- Production shared/core build and compiled HTTP/chat/restart smoke pass, with two
  clean process exits. All **17 isolated browser journeys pass**.
- Original definition hashes differ only for the reviewed W1c skill/default-agent
  changes and previously authorized F9b maintenance template. Owner IDE files,
  source projects and `next-env.d.ts` are preserved.

Checks use temporary fixtures and fake providers; no live owner model, graph or
sibling repository work was run. Mobile artifact access and graph filtering are
next in W1d; final graph/container/deployment acceptance remains W1e.
