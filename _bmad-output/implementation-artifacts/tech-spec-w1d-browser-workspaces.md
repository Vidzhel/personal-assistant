---
title: Browser workspaces, artifacts and project graph views
status: complete
baseline: 586d2b2
date: 2026-09-06
---

# Browser workspaces, artifacts and project graph views

W1a–W1c provide direct repository execution, current context and project-owned
memory. This checkpoint makes configuration and generated files usable from a
mobile browser, and scopes the graph view to an explicitly selected project.

## Implementation contract

- Add a Workspace tab using the existing YAML workspace/source API. Attach and
  edit folder sources, labels and context-file pointers; select managed home or
  an attached cwd and default/auto/full execution. Explain that paths are on the
  server and full mode is trusted host execution. Remove/deselect sources without
  deleting repository contents. Existing URL/reference sources remain supported.
- Add project file APIs resolving current project/source IDs, with reserved source
  ID `home` for the managed directory. No arbitrary server path endpoint. Bounded
  listings expose source-relative paths and a revision for the current root grant.
  File info and content use the same resolver; changed grants, detached sources,
  traversal, symlink components and special files cannot serve content. Descriptor
  reads/streams and bounded sizes retain ownership during asynchronous responses.
- API contract: GET `/api/projects/:id/files?sourceId=home&path=` returns
  `{projectId,sourceId,path,revision,entries,truncated}`. Entries have `name`, `path`,
  `type` (file/directory), `size`, `modifiedAt`, and `preview`
  (text/image/pdf/html/none) where applicable. GET `/files/info` accepts source/path
  and returns the same root identifiers plus name/size/modifiedAt/preview/mimeType.
  GET `/files/content` accepts source/path/revision and optional `download=1`.
  Text/Markdown is inert text; known raster images can preview; PDFs use a bundled browser renderer, HTML uses a
  script-free, opaque-origin sandbox and restrictive CSP. Other formats download.
  No HTTP request runs a render command. Repository scripts can generate previews.
- Browser file navigation supports arbitrary working folders, breadcrumbs, refresh,
  file previews and downloads with errors visible. Clear obsolete requests/previews
  on project/source changes. Artifact links resolve a task's actual project and a
  current source-relative path; absolute paths must be inside a current grant.
  Update task protocol to use repository output conventions instead of global
  `data/artifacts/`. Existing global generated-file delivery must use the same safe
  serving primitives, without treating every unknown route as a forbidden path.
- Graph page requires explicit project selection. Server graph queries validate
  current project identity and filter durable BELONGS_TO_PROJECT membership;
  returned edges have both endpoints in the selected node set. Graph controls
  cannot reintroduce foreign nodes through global search results. Clear stale
  selection/highlights on project changes; preserve existing knowledge links.

## Acceptance and checks

- Two projects with separate managed homes and attached repositories; no source
  crossover, stale grant exposure, symlink/traversal escape or special-file hang.
  Exercise encoded filenames, missing mounts, oversized content and safe headers.
- Mobile attachment/settings, navigation, text/image/PDF/HTML preview and download.
  A real temporary shell task creates an artifact, commits and pushes to a local
  bare remote; browser access and restart still show the actual output.
- Disposable graph integration covers A-only/B-only/shared bubbles and links;
  explicit UI selection survives reordered lists and clears stale selections.
- Parent review, focused tests, required checks, default regression, production
  builds, browser journeys and compiled restart before commit/push. Final deployment
  mounts/tools, graph and container verification continue in W1e.

## Review findings resolved

- The predecessor source editor was removed from Knowledge; Workspace owns
  attachment management, avoiding two views with stale independent settings.
- Missing attachment paths now retain the form draft; listing errors leave Refresh
  usable. Direct source-relative navigation reaches files outside bounded listings.
- File registration checks existence and persists source identity before completion;
  a missing file cannot silently satisfy an artifact requirement. Task views resolve
  the stored tree's current project instead of constructing a URL from model text.
- Descriptor reads, root identity revisions, UTF-8 filenames, special-file rejection,
  capped streams and repeated HEAD cleanup have tests using real temporary registries,
  workspace stores and directories. Global markup downloads cannot execute inline.
- Delayed graph loads/searches cannot restore the previous project's state. Graph
  legends and conversations fit the mobile viewport.
- An initial browser test accepted a visible but blank native PDF iframe. Visual
  inspection caught it. The replacement uses pinned PDF.js 6.3.289, a locally bundled
  worker, one rendered page at a time and a 32 MiB limit. The browser journey verifies
  drawn pixels, page navigation and invalid-document errors. Ordinary downloads remain
  capped at 512 MiB. No backend HTTP handler runs a rendering command.
- The unrestricted default test pool hit four unrelated five-second deadlines under
  concurrent load. The runner now caps workers at four; all 2,466 tests pass with the
  same deadlines (six explicit live-account skips).

## Verification

The current default suite passes 242 files / 2,466 tests, with six explicit live
skips. The disposable graph route suite passes 40 tests. Core build and packaged
restart pass. Required check, both definition validators, production dashboard build and all
19 browser journeys pass. The corrected PDF screenshot visibly shows the report;
canvas pixels, second-page text, page navigation, invalid PDF handling, source
removal and Unicode download bytes are asserted. The local Git remote contains the
actual generated report. Compiled core verification exercises clean restart, and
composed execution checks retain file access after restart and revoke stale grants.

Evidence: `/tmp/raven-w1d-full-final.log`, `/tmp/raven-w1d-browser-final.log`,
`/tmp/raven-w1d-check-final.log`, `/tmp/raven-w1d-build-core.log`,
`/tmp/raven-w1d-build-web.log`, `/tmp/raven-w1d-compiled.log`,
`/tmp/raven-w1d-files-parent.log`, `/tmp/raven-w1d-execution-root.log`,
`/tmp/raven-w1d-graph.log`. PDF.js installation and the reviewed lockfile audit
reported no vulnerabilities. Tests use fake model/provider responses and isolated
filesystems; no live Claude/account operation or production deployment is claimed.
W1e remains responsible for deployment mounts/tools/defaults and final containers.
