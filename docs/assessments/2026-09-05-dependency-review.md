# Dependency review — September 5, 2026

The initial npm audit reported seven affected packages: four high and three
moderate. Compatible updates replaced Fastify 5.11.2 with 5.12.3, fast-uri
3.1.5/4.1.2 with 3.1.7/4.1.4, nanoid 3.3.17 with 3.3.18, qs 6.15.3 with
6.16.0, and @humanfs/node 0.16.7 with 0.16.8 (plus its required core/types).
The reviewed final lockfile reports **zero npm audit vulnerabilities**. This is a
dated advisory result, not a guarantee that no unknown vulnerability exists.

## Embedding dependency

Transformers 3.8.1 requests Sharp ^0.34.1. Even Transformers 4.2.0 still requests
the affected 0.34 series, so a major model-library migration would not resolve
this advisory. The [upstream advisory](https://github.com/lovell/sharp/security/advisories/GHSA-f88m-g3jw-g9cj)
identifies untrusted image processing through Sharp below 0.35 as affected.
Raven uses Transformers for text feature extraction only, but its Node module
imports Sharp. That narrows observed exposure without removing the dependency.

The root override pins only Transformers' Sharp dependency to 0.35.4. Next's
existing ^0.35.3 range also resolves to 0.35.4. Review of the
[0.35 API/packaging changes](https://sharp.pixelplumbing.com/changelog/v0.35.0/)
found no removed API used by the installed Transformers adapter. The
[0.35.4 patch](https://sharp.pixelplumbing.com/changelog/v0.35.4/)
is available in npm and includes libvips 8.18.6 on the tested Linux platform.

`npm run check:dependencies` verifies the actual Sharp resolved by core's
Transformers import and rejects vulnerable copies in the lockfile. The separate,
explicit `npm run test:embeddings:download` downloads only the public BGE model
into temporary storage, runs Raven's compiled fp32 embedding pipeline, and tests
384 finite normalized values, repeatability and distinct sentences. A second
process uses that same cache with remote models disabled. Synthetic PNG, resize,
crop and padding operations exercise the Transformers/Sharp adapter. It does not
use an owner graph, model cache, credentials or project files.

## Node and npm

Use Node >=22.22.0 and npm 10.9.8 (declared in engines/packageManager). Verification
uses Node 22.23.2 with npm 10.9.8 from a temporary installation; the owner's global
Node/npm installation is unchanged. The tested Docker Node 22 image also bundles
npm 10.9.8. Testcontainers requires Node >=22.22; the original host 22.14 was below
that declared requirement even though R5's tests passed.

The host's npm 11.7 silently retained Sharp 0.34.5 despite the root override.
Using npm 10.9.8 and `npm update sharp --ignore-scripts` applied it correctly.
This matches the class of [upstream workspace override issues](https://github.com/npm/cli/issues/9659).
After changing package managers, use the declared npm version and `npm ci`;
run `npm run check:dependencies` before relying on the installed tree. The guard
also runs as part of the normal required check.

Remove this override only when Transformers' declared dependency accepts a
patched Sharp version and clean install, native import, real embedding smoke,
builds and browser/compiled regressions all pass. Do not remove it just to make
a package-manager warning disappear. Supported prebuilt native binaries were
verified on Linux; other platforms need their own native smoke.
