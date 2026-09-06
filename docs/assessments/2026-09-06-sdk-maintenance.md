# Claude Agent SDK maintenance — September 6, 2026

Raven's Claude Agent SDK is upgraded from `0.3.224` to exact version `0.3.261`
in commit `135fcde`.
The upgrade passed the default suite, SDK subprocess contract, required checks,
compiled restart and clean production image build. No runtime adapter changes
were necessary. The owner's running test deployment was not replaced.

## Version choice and scope

The reviewed upstream release is `0.3.261`, with Claude Code `2.1.261` parity.
The release includes plugin initialization delivery and disposal fixes.
[Official release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.261).

Direct public npm metadata also returned `0.3.263` during verification. The fetched
official changelog ended at `0.3.261`, so the manifest pins the reviewed version
instead of letting a caret select the newer package. Review the subsequent changes
before advancing the pin; this update does not claim to install the latest npm tag.
[Package metadata](https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest),
[official changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

The manifest and lock diff contains the Agent SDK plus its eight optional native
platform packages. The existing Anthropic Messages SDK peer remains `0.115.0`.
No other dependency versions, capability grants, model defaults or project files
were changed. Keep the prior lockfile and deployed image available for rollback.

## Verification

Local verification used Node `22.23.2` and npm `10.9.8`.

| Check                         | Result                                         | What it establishes                                                                            |
| ----------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run check`               | Passed                                         | Formatting, lint, shared/core types, strip-only production source parsing and dependency guard |
| `npm test`                    | 242 files; 2,467 passed, 6 explicit live skips | Default regression baseline with the new SDK                                                   |
| Real SDK subprocess contract  | 9 passed                                       | Real SDK process/serialization behavior against a fake executable, without account inference   |
| `npm run build:core`          | Passed                                         | Shared, core and local TickTick production compilation                                         |
| `npm run test:compiled`       | Passed                                         | Packaged HTTP/chat, persisted definitions/memory/history and two clean process exits           |
| Clean `Dockerfile.core` build | Passed                                         | Fresh `npm ci` and packaged production image, independent of local installed modules           |
| Offline image version check   | Passed                                         | Node `22.23.2`, SDK and native package `0.3.261`, executable reports Claude Code `2.1.261`     |

The review image is `raven-sdk-review-core:0.3.261`; its manifest-list digest is
`sha256:1f60215425a2add9ed3f7992e18e7de1aacc221ba9ad0508e99c3587af06fc9d`.
The version check ran with networking disabled and no owner data mounted.

The existing local npm dependency graph produced an `edgesOut` installer error.
The SDK packages were reconciled locally to run tests; the separate clean image
build then verified that the committed lock installs successfully from scratch.
The restricted runner also blocked a subprocess contract path; it passed in the
normal test environment with temporary data and the same fake executable. Neither
environment failure required a production workaround or weaker assertion.

These results do not verify owner-account model entitlements, live Telegram
delivery, authenticated TickTick behavior or an in-flight model switch. No new UI
behavior was implemented, so browser journeys were not rerun for this dependency
change. The default suite's live skips remain explicit; no external task mutations
or model requests were used as verification.

## Follow-up

The [delivery queue](../../_bmad-output/implementation-artifacts/personal-assistant-next-steps-2026-09-06.md)
records the newer SDK release review, official TickTick compatibility trial, skills
maintenance defects and model-control work. Those proposed features are separate
from this completed dependency update.
