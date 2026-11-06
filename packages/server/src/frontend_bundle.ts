/**
 * Embedded frontend bundle (HTMLBundle) — the ONLY place that statically
 * imports the built Vite `index.html`.
 *
 * ## Why a dedicated module
 * `bun build --compile` embeds an `HTMLBundle` (and its re-bundled +
 * content-hashed assets) into the standalone binary ONLY when the HTML is
 * referenced via a *static* `import` that the compiler can trace. A dynamic
 * `import()` is NOT traced by `--compile` (it fails at runtime with
 * "require_build is not defined"), so the static import has to live here.
 *
 * ## Resilience for dev / test (build may be absent)
 * A static import of a non-existent file fails to *resolve*. Callers therefore
 * never import this module statically; they load it via
 * `loadFrontendBundle()` which does `await import("./frontend_bundle.ts")`
 * inside a try/catch:
 *   - Compiled binary: the frontend build exists at compile time, so the static
 *     import below resolves and the compiler traces through the dynamic import
 *     to embed the HTMLBundle. `loadFrontendBundle()` returns it.
 *   - Dev / `bun test` without a build: the dynamic import throws
 *     ("Cannot find module .../packages/frontend/build/index.html") and
 *     `loadFrontendBundle()` returns null, so the caller falls back to the
 *     on-disk build dir or the placeholder page.
 *
 * The import specifier MUST be a static string literal (no template/computed
 * path) so the compiler can trace it.
 */

// @ts-ignore - HTMLBundle import; resolves only when frontend/build exists.
// Uses @ts-ignore (not @ts-expect-error) because when a build IS present the
// import type-checks fine and an "unused directive" would otherwise fire.
import index from "../../frontend/build/index.html";

/** Bun's opaque HTMLBundle marker (served directly as a Bun.serve route value). */
export type HtmlBundle = unknown;

/** The embedded built index.html (an HTMLBundle). */
export default index as HtmlBundle;
