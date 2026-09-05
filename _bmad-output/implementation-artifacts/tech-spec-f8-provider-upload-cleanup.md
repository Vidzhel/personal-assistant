---
title: Durable Gemini upload cleanup through existing maintenance
created: '2026-09-05'
status: complete
execution_mode: plan-code-review
---

## Contract

Every file upload gets a durable Raven attempt ID before provider dispatch, with
its event correlation, optional project, source path, timestamps and cleanup
state. Add `gemini_uploads` to the fresh operational SQLite schema; no legacy
migration/export or extra scheduler. Inline voice requests do not upload files.

A single Raven-owned `GeminiUploadCleanup` is passed through ServiceContext. Its
API is `begin(input): string`, `observeUpload(id, promise)`, `finish(id): void`,
`recoverInterrupted(): void`, `retryPending(): Promise<GeminiCleanupReport>`,
`getReport(): GeminiCleanupReport`, and `stop(): Promise<void>`. The provider
promise/result types may use the installed Google upload types. Construction
accepts the existing DatabaseInterface, an injectable exact-file deletion
function `(name, signal) => Promise<void>`, and optional clock/deadline test seams.
The real deleter creates GoogleAIFileManager with its own current signal and
reads the configured API key only when called. Never reuse a cancelled
transcription signal. No key means pending cleanup with an explicit reason.

States are `uploading`, `active`, `pending_delete`, `unknown`, and `deleted`.
Capture and persist the exact returned remote name before exposing a successful
upload result. Observe the raw upload promise even after its local wait aborts:
while the coordinator lives, a late name turns unknown work into pending cleanup.
Validate names as either a bare resource ID or `files/<id>` (letters, digits,
underscores and hyphens); retain the exact value, never infer it from a local
basename or enumerate/delete unrelated account files. Invalid/missing names stay
unknown and cannot proceed to inference. Failed processing can still yield a
known name that must be removed. Polling must not replace the upload's identity.

Wrap upload, polling and inference together in a finally that calls `finish`.
Finishing synchronously persists pending deletion (known name) or unknown outcome
(no name), then launches an owned bounded deletion attempt without delaying local
transcript completion. Active uploads/inference are never selected by maintenance
cleanup. Duplicate event correlations have distinct attempt IDs. Deletion success
or a provider error with numeric status 404 marks deleted; other failures and
local timeouts retain pending state and last error. Duplicate retry calls share
one local attempt per record. A retry pass considers at most 25 pending records, ordered by fewest attempts
then oldest update and ID so persistent failures cannot starve the rest. Each
attempt has a bounded wait and observes late provider results.
All timers/listeners are cleared when a local attempt settles.

Startup turns interrupted uploading records without IDs into unknown and known
active records into pending deletion, then starts one bounded retry pass. Existing
system maintenance retries pending cleanup and appends a deterministic report even
when model-written analysis exists. Reports include status counts and at most 100
unresolved records with correlation, exact known ID, attempt count and last error;
state truncation explicitly. Expose the same read-only report at
`GET /api/provider-uploads` for diagnosis without model execution. No retry of
unknown IDs and no invented confirmation of remote deletion.

Shutdown closes coordinator admission, synchronously records unknown/pending
outcomes for locally active uploads, aborts/drains its own deletion waits, and
prevents late callbacks from writing after database disposal. Begin coordinator
stop in Raven's early cancellation phase alongside transcription service stop;
finish calls after coordinator stop are harmless because stop already persisted
the unresolved state. A service-only restart leaves the shared coordinator alive,
so late remote IDs can still be captured. No process can recover an ID that the
provider never returned before whole-process shutdown; retain that unknown
outcome explicitly. Client cancellation never proves remote inference stopped.

## Verification

Use real temporary SQLite and fake Google SDK/deferred promises: record-before-
dispatch; ordinary success; processing failure with known name; cancellation
through upload, polling and inference; late upload ID after service stop; request
timeout; separate cleanup signal; deletion failure/404/timeouts; duplicate retry
and correlation isolation; active file exclusion; fresh coordinator recovery;
late deletion/upload completion after coordinator/database close. Test real Raven
HTTP report and shutdown composition without accounts. Existing transcript-path
and lifecycle behavior must remain intact. Required check, full default tests,
fresh core build, isolated browser journeys and packaged restart precede parent
review, commit and push.


Parent review also exposed duplicate maintenance registration on service restart.
JobRegistry registration now returns an idempotent release callback; maintenance
releases its job on stop. Already admitted handlers still settle, and an old
release callback cannot remove a replacement registration. The real-registry
maintenance restart test verifies the service keeps its original cleanup
coordinator for an admitted pass. Other registered integration services adopt
this ownership contract in F9's already planned lifecycle work.

## Parent review and evidence

The upload observer returns the same chain that persists the provider ID, so a
failed capture rejects before inference. The former no-coordinator deletion
fallback is removed. Polling cannot switch remote identity. Cleanup uses only
the installed provider's numeric `status: 404` as confirmed absence; string codes
and unrelated status fields remain unresolved. A failing shutdown persistence
step still aborts and drains local cleanup, then reports the failure; diagnostics
never fabricate an empty successful report.

Required checks and the default suite passed: 213 files, 2,223 tests and six
explicit live skips. Parent's additional tests cover cleanup deadlines/timer
release, stop before provider dispatch, fair retry batches, report truncation,
correlation/project isolation and persistence failure. Voice tests use real
temporary SQLite with fake providers. Packaged restart passed with two clean
process exits. All fourteen isolated browser journeys passed against the fresh
core build. All 87
original project/library definition hashes remain unchanged.
