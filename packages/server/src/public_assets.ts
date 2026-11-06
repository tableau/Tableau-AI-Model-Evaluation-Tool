/**
 * Embedded `public/` root static files (favicon, PWA manifest, PWA logos).
 *
 * ## Why this module exists
 * The compiled binary serves the UI from an embedded `HTMLBundle` (see
 * frontend_bundle.ts + server.ts, tier 2). Bun's `HTMLBundle` only embeds the
 * built `index.html` and the assets in ITS module graph (the hashed JS/CSS
 * chunks and images `import`ed by the app). The Vite `public/` files —
 * `favicon.ico`, `manifest.json`, `logo192.png`, `logo512.png`, `robots.txt` —
 * are copied to `build/` root and referenced only by URL (from `index.html`
 * and `manifest.json`), so they are NOT in the bundle graph and the compiled
 * binary cannot serve them. On-disk serving (tier 1, `bun start`) reads them
 * straight from `build/`, so the gap only shows in the compiled binary: the PWA
 * manifest icon `/logo192.png` (and `/favicon.ico`, `/manifest.json`, …) 404 to
 * the SPA fallback, and the browser reports "resource isn't a valid image".
 *
 * ## How it's embedded
 * `import ... with { type: "file" }` yields a runtime file path that
 * `bun build --compile` embeds into the binary; `Bun.file(path)` reads the
 * embedded bytes at runtime. This mirrors frontend_bundle.ts's static-import
 * requirement: the specifiers MUST be static string literals so the compiler
 * can trace and embed them. Loaded via `loadPublicAssets()` inside a try/catch
 * so dev/test builds without a `frontend/build` still work (the imports resolve
 * against `frontend/public`, which is always present in the repo, but the load
 * is defensive to match the frontend-bundle seam).
 */

// @ts-ignore - file-type import; resolves to an embedded path under --compile.
import faviconIco from "../../frontend/public/favicon.ico" with { type: "file" };
// @ts-ignore
import manifestJson from "../../frontend/public/manifest.json" with { type: "file" };
// @ts-ignore
import logo192 from "../../frontend/public/logo192.png" with { type: "file" };
// @ts-ignore
import logo512 from "../../frontend/public/logo512.png" with { type: "file" };
// @ts-ignore
import robotsTxt from "../../frontend/public/robots.txt" with { type: "file" };
// @ts-ignore - the header logo lives in public/ (not a Vite import) so it gets a
// stable unhashed URL the compiled binary can serve.
import tableauLogo from "../../frontend/public/tableau-logo.png" with { type: "file" };

/** Root request path -> {embedded file path, Content-Type}. */
export interface PublicAsset {
  file: string;
  contentType: string;
}

/**
 * The embedded public/ root files, keyed by their served URL path. Content
 * types are pinned so the embedded (tier 2) path matches the on-disk (tier 1)
 * MIME contract exactly.
 */
const PUBLIC_ASSETS: Record<string, PublicAsset> = {
  "/favicon.ico": { file: faviconIco as string, contentType: "image/x-icon" },
  "/manifest.json": {
    file: manifestJson as unknown as string,
    contentType: "application/json; charset=utf-8",
  },
  "/logo192.png": { file: logo192 as string, contentType: "image/png" },
  "/logo512.png": { file: logo512 as string, contentType: "image/png" },
  "/robots.txt": {
    file: robotsTxt as string,
    contentType: "text/plain; charset=utf-8",
  },
  "/tableau-logo.png": { file: tableauLogo as string, contentType: "image/png" },
};

export default PUBLIC_ASSETS;
