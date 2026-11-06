# Developing the Tableau AI Model Evaluation Tool

This page is for people who build, test or release the tool. If you want to run
evaluations against your Tableau Server, use the [README](../README.md) instead:
it starts from the downloaded executable and needs none of this.

The tool is written in TypeScript for the [Bun](https://bun.sh) runtime (`>= 1.4`;
install with `curl -fsSL https://bun.sh/install | bash`) and compiles to a
standalone executable for macOS arm64, Linux x64 and Windows x64 (the Tableau
Hyper native addon ships prebuilt for these; Intel macOS would need a build from
source). [GOLDENS.md](GOLDENS.md) documents the regression fixtures and public
library references, and [RUN_LIFECYCLE.md](RUN_LIFECYCLE.md) describes how a run's
state is committed and how the browser observes it.

## Repository layout

```
packages/
  core/    @tableau-ai-eval/core — shared: adapter contract/registry, DB (bun:sqlite),
           SSE, Tableau session/TLS/preflight/trust, BYOK LLM judge, env config.
  evals/   @tableau-ai-eval/evals — metrics + lib primitives, Tableau calc
           validator, harness runners, concrete adapters (nlq/prep/cabu/palettes).
  server/  @tableau-ai-eval/server — HTTP routes (Bun.serve), app/server/
           cli/entry, job orchestrator, CES bridge + record/replay, publish
           (.hyper builder + Tableau REST), suite catalog, hyperdb-api-node loader
           (embeds under bun --compile), embedded Vite frontend.
  frontend/  Vite/React app (self-contained; own node_modules,
             own package.json/tsconfig; built to packages/frontend/build).
goldens/        Library-faithfulness + validator/viz/publish golden fixtures (repo root)
scripts/        build.ts (bun build --compile; Hyper downloaded on first use)
docs/           Durable documentation (this guide, GOLDENS.md, CALC_GRAMMAR.md,
                RUN_LIFECYCLE.md, EXPORT_COLUMNS.md)
```

Bun workspaces monorepo. Dependency direction is acyclic: `server → evals → core`, `server → core`.
The server registers the concrete eval adapters (`@tableau-ai-eval/evals`' `registerAdapters()`) at its
composition root; `@tableau-ai-eval/core` never imports the concrete adapters (no cycle).

## Backend

### Install

```sh
bun install   # also builds the frontend (packages/frontend/build) via postinstall
```

### Run (development)

```sh
bun dev                          # backend (:8000) + Vite HMR (:5173) — open http://localhost:5173
bun start                        # single-origin: serve API + built UI on http://localhost:8000
bun start --port 8080            # different port
bun start --host 0.0.0.0         # bind all interfaces (default 127.0.0.1)
bun start --allow-self-signed    # reveal the TLS-verify toggle in the UI
```

Two modes:

- **`bun dev`** — for iterating on the frontend. Runs the backend and the Vite dev
  server together; **open http://localhost:5173** (Vite proxies `/nlq-eval/*` and the
  other API prefixes to the backend on :8000). Frontend edits hot-reload; no build
  step. The backend serves no UI in this mode — opening http://localhost:8000
  redirects to Vite, so a stale `packages/frontend/build` is never shown. Ctrl-C
  stops both, and if either process dies the other is torn down too.
- **`bun start`** — single-origin (prod-like, matches the compiled binary): serves the
  API **and** the built UI from :8000. It auto-rebuilds `packages/frontend/build` when
  the frontend source changed since the last build (mtime check in the `prestart`
  hook), so the served UI is never stale. It forwards flags to the `serve` command.

`bun trust <url> [--out <path>]` writes a CA bundle (default `~/.tableau-ai-eval/ca.pem`) without
a build. `bun run packages/server/src/cli.ts rescore <run id…>` (or `--all`; `tableau-ai-eval
rescore` from a compiled build) scores finished runs again with the current chart
metrics, from the chart definitions they stored and without calling the server; the
evaluator's and the judge's metrics stay as they are. Restart the tool afterwards. `version` runs via `bun run packages/server/src/cli.ts version` (or `tableau-ai-eval
version` from a compiled build).

`GET /health` and `GET /nlq-eval/*` are available immediately. `bun install` builds the
frontend into `packages/frontend/build`, so `bun start` serves the UI from `/` with no
manual step. (If the build dir is missing entirely, the root path serves a placeholder;
`bun start`/`bun install` rebuild it, or run `bun run scripts/build-frontend.ts`.)

### Test

```sh
bun test                 # full suite
bun typecheck            # tsc --noEmit
```

### Configuration (environment)

| Variable | Purpose | Default |
| --- | --- | --- |
| `TABLEAU_AI_EVAL_BIND` | Bind host | `127.0.0.1` |
| `TABLEAU_AI_EVAL_PORT` | Port | `8000` |
| `TABLEAU_AI_EVAL_DEBUG` | Debug mode | off |
| `TABLEAU_AI_EVAL_DATA_DIR` | SQLite DB location | `<bundle>/data` (dev) / `~/.tableau-ai-eval` (compiled) |
| `TABLEAU_AI_EVAL_FRONTEND_DIR` | Directory of the built React app | dev: `packages/frontend/build`; compiled: `<binary-dir>/frontend/build` |
| `TABLEAU_AI_EVAL_DEV_UI_URL` | Origin of a dev UI server; when set, non-API GETs redirect there instead of serving a built UI (`bun dev` sets it to the Vite URL) | unset |
| `HYPERD_PATH` | Explicit override for the `hyperd` binary (not the addon) | release cache / installed node_modules package |
| `TABLEAU_AI_EVAL_ALLOW_SELF_SIGNED` | Set to `1` to surface the TLS-verify toggle + CA hints in the UI (same as `--allow-self-signed`) | off |
| `TABLEAU_AI_EVAL_CA_BUNDLE` | Path to a PEM CA bundle to trust (keeps TLS verification **on**) | auto-detects `~/.tableau-ai-eval/ca.pem` if present |
| `TABLEAU_AI_EVAL_PREP_ROOT` | A folder of Prep flows and step data to use instead of the `prep-bench/` that ships with the tool | the shipped `prep-bench/` |
| `TABLEAU_AI_EVAL_REQUEST_TIMEOUT` | Seconds a test case waits for the server to answer one request before it tries again (three attempts in all). Raise it if your model's gateway is slower. | `120` |
| `TABLEAU_AI_EVAL_MAX_CONCURRENCY` | Test conversations a run works on at once (`1` = strictly sequential) | `3` |
| `TABLEAU_AI_EVAL_JUDGE_CONCURRENCY` | Evaluator-model calls in flight at once | `2` |
| `TABLEAU_AI_EVAL_PUBLIC_SUITES` | A `public-suites/` folder to use instead of the bundled one | bundled copy, then the checkout |

### Connecting to a Tableau Server with a self-signed certificate

The admin-facing version of this is in the README's Troubleshooting section.

On-prem/dev servers often present a self-signed or private-CA certificate that
fails default TLS verification ("Server reachable: failed … certificate verify
failed"). Three ways to connect, most-secure first:

1. **Trust the server's CA (verification stays on) — recommended.**
   ```sh
   tableau-ai-eval trust https://your-tableau-server      # writes ~/.tableau-ai-eval/ca.pem
   tableau-ai-eval serve                                   # auto-detects the bundle
   ```
   In dev (no compiled binary), use the script aliases — same effect, no build:
   ```sh
   bun trust https://your-tableau-server          # writes ~/.tableau-ai-eval/ca.pem
   bun start                                       # auto-detects the bundle
   ```
   Or point at an existing bundle: `TABLEAU_AI_EVAL_CA_BUNDLE=/path/to/ca.pem tableau-ai-eval serve`.

2. **Disable verification for a trusted dev server (toggle in the UI).**
   Start with `tableau-ai-eval serve --allow-self-signed` — this reveals the
   **Verify TLS certificate** toggle in Settings → Tableau Server Connection
   (without needing developer mode) and defaults it OFF for a new connection.
   Traffic is then not authenticated against a trusted CA — use only for dev
   servers you trust.

3. **Developer mode.** `http://localhost:8000/?dev=1` also exposes the toggle
   (along with other developer-only UI).

The **CES base URL** is optional — leave it blank and the tool derives
`<server>/content-exploration`, so the connectivity test's *Generations* stage
is probed even on a brand-new (unsaved) connection.

Runtime credentials (Tableau PAT, LLM API keys) are supplied via the app's settings routes,
not committed to the repo. A local `config` scratch file, if present, is git-ignored.

## Frontend (Vite)

Self-contained under `packages/frontend/` with its own dependencies. It is a Bun
workspace (so root `bun install` installs it AND builds it via postinstall) but is
NOT part of the TypeScript build graph — the server consumes it only as a build
artifact (embedded `HTMLBundle` + on-disk static files), never via `import`.

```sh
# For hot-reload iteration, run `bun dev` from the repo root (backend + Vite together,
# open http://localhost:5173). To run just the Vite dev server from the package dir:
cd packages/frontend
bun run dev      # Vite dev server (proxies API calls to the backend on :8000)
bun run build    # production build -> packages/frontend/build/ (also: bun run scripts/build-frontend.ts from root)
```

The dev server proxies `/nlq-eval/*` and the other API prefixes to `http://localhost:8000`,
so the backend must be running alongside it — `bun dev` (from the repo root) starts both.

## Full stack (backend serves the built UI)

`bun install` builds the frontend, so a single `bun start` serves UI + API from
one origin — no manual build step, no `TABLEAU_AI_EVAL_FRONTEND_DIR`:

```sh
bun install   # builds packages/frontend/build via postinstall
bun start     # -> http://localhost:8000  (UI + API together)
```

## Compile to a standalone binary

```sh
bun compile              # native executable only; or: bun run scripts/build.ts
bun compile --target linux-x64
bun compile --all        # macOS ARM64, Linux x64 (glibc), Windows x64
```

Produces:

- `dist/tableau-ai-eval` (`tableau-ai-eval.exe` on Windows) — the executable with the Bun runtime,
  backend, frontend, and test content. Neither the Hyper addon nor `hyperd` is embedded.
- Explicit target / all-target builds go under `dist/targets/<target>/` instead.

Run the compiled binary:

```sh
cd dist
./tableau-ai-eval version
./tableau-ai-eval serve --port 8000
```

Notes:
- The single executable is the distribution — no Python, Bun, npm, or `node_modules`
  installation is needed. Server startup does not download or load Hyper.
- **Hyper on first use**: publishing results downloads the pinned platform npm package
  (`hyperdb-api-node-<platform>@0.7.3`) from `registry.npmjs.org`, verifies its committed
  SHA-512 integrity, and atomically installs the addon and `hyperd` together under
  `~/.tableau-ai-eval/bin/hyperdb-api-node/0.7.3/<platform>/`. Cached files are checked with SHA-256
  before loading. Later uses work offline. Download/install failures appear in the
  existing publish error toast and can be retried. For offline deployments, pre-populate
  this cache (including `verified.json`) from a successful install on the same platform.
  Version and integrity pins live in `packages/server/src/hyper/release.ts`; update both
  together when upgrading. `bun start` / `bun dev` only use the installed npm package.
  Downloads use default public TLS trust first; if certificate verification fails,
  they retry with the tool's configured CA bundle for corporate proxies. Verification
  stays enabled. A Tableau-only CA bundle does not replace npm's public trust roots.
  Old `dist/hyperd` sidecars are no longer used or required by releases.
- **Cross-platform**: Bun can cross-compile from one machine to `darwin-arm64`,
  `linux-x64` (glibc), and `windows-x64`. x64 builds use Bun's baseline CPU target.
  Execution and Hyper loading still need testing on each target OS.
  Releases require a published, pinned Hyper platform package;
  Intel macOS, Linux ARM64, and musl packages are not published for the current pin.
- **Embedded test content**: only `public-suites/` and `prep-bench/`
  are embedded as an indexed pack — one zstd frame per file, compressed
  with the committed dictionary `scripts/content.zdict`; already-compressed files (`.tdsx`)
  are stored as-is. The binary reads files straight out of the pack, decompressing only the
  file asked for; nothing is extracted to disk. The compressed pack (~30 MiB) is loaded into
  memory once at start-up. `bun start` / `bun dev` read the plain files
  in the checkout instead. See [Retraining the content dictionary](#retraining-the-content-dictionary).

### Package and publish a release (no GitHub Actions required)

```sh
bun release                          # native binary + ZIP; no GitHub access
bun release --target windows-x64     # one target + ZIP
bun release --all                    # all three targets + ZIPs
bun release:publish                  # rebuild all, package, upload a GitHub draft
bun release:publish --public         # also make the uploaded draft public
bun release:publish --no-build       # verify and upload existing all-target ZIPs
bun release:publish --hostname github.com # override origin's host (same owner/repo)
```

The version comes from the root `package.json`; `0.1.0` becomes tag `v0.1.0`.
Archives go in `dist/releases/v<version>/`, named
`tableau-ai-eval-v<version>-<target>.zip`. Each contains the executable, `README.md`, `LICENSE.txt`, and `SECURITY.md`
(Unix executable permissions preserved). `SHA256SUMS` and `manifest.json`
record archive checksums, targets, version, source commit, and checkout cleanliness.
The manifest determines which files are uploaded; unrelated or stale ZIPs are ignored.

Publishing requires the [GitHub CLI](https://cli.github.com/) (`gh auth login`),
a clean checkout including initialized submodules, and a source commit already
pushed to the destination GitHub repository. The destination is the repository
derived directly from this checkout's `origin` URL (HTTPS, SSH URL, or
`git@host:owner/repo.git`), including its GitHub Enterprise host when applicable.
Use `--hostname <host>` to override that host while retaining origin's
owner/repository path; authenticate with `gh auth login --hostname <host>`.
All API requests and uploads explicitly use that destination, rather than
`GH_HOST` or the GitHub CLI's preferred remote. An absent or unparseable origin
fails with an error instead of guessing a destination.
**Do not create the tag yourself:**
the release command targets the exact source commit and GitHub creates the tag
when the release is published. If the tag exists locally or on GitHub, or a
release/draft already uses it, the command stops before building and asks you to
update `package.json`, commit, and push. Existing releases are never overwritten.
Prerelease versions (such as `0.2.0-beta.1`) are marked as prereleases.

Local compilation/packaging allows uncommitted work, but those artifacts cannot
be published with `--no-build`. That option requires an all-target manifest from
the same clean commit and version, with matching checksums. It is useful after
testing ZIPs or when retrying a failure before a draft was created. If an upload
leaves a draft behind, inspect it on GitHub and complete it manually (or remove
that incomplete draft deliberately before retrying); this command does not
silently overwrite it. No tag or release is created by local packaging.

### Retraining the content dictionary

The dictionary only affects the release's size, never correctness: a stale one still
round-trips every file, it just compresses less. Retrain when the test content changes
substantially — a new suite, a reshaped case format, or new datasets:

```sh
bun run train-dict             # trains a 64 KiB dictionary, prints old vs new pack size, writes scripts/content.zdict
bun run train-dict --dry-run   # compare only
bun run train-dict --size=131072
```

Then commit `scripts/content.zdict`. Training is the only step that needs the `zstd` CLI
(1.4+, on `PATH`: `winget install Facebook.zstd`, `brew install zstd`, `apt install zstd`);
`bun release` and the binary use Bun's built-in zstd. The dictionary covers all bundled
content.
