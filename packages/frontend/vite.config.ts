import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev proxy prefixes — reproduced EXACTLY from the CRA src/setupProxy.js.
// All forward to the backend on :8000 with changeOrigin.
const PROXY_PREFIXES = [
  "/nlq-eval",
  "/evaluate-test-cases",
  "/evaluate-status",
  "/evaluate-results",
  "/evaluate-events",
  "/evaluate-cancel",
  "/get-models",
  "/get-test-cases",
  "/upload-custom-assets",
];

const proxy = Object.fromEntries(
  PROXY_PREFIXES.map((prefix) => [
    prefix,
    { target: "http://localhost:8000", changeOrigin: true, ws: true },
  ]),
);

export default defineConfig({
  plugins: [react()],
  // CRA-parity glue: src/api.ts reads `process.env.REACT_APP_API_BASE_URL`.
  // Vite has no Node `process.env`, so we statically replace exactly that
  // expression at build/dev time. This keeps src/api.ts UNMODIFIED. Value
  // comes from VITE_API_BASE_URL when set, else undefined (so api.ts falls
  // back to window.location.origin, the production behavior).
  define: {
    "process.env.REACT_APP_API_BASE_URL": JSON.stringify(
      process.env.VITE_API_BASE_URL ?? "",
    ),
  },
  // Emit RELATIVE asset URLs (`./assets/...`) rather than root-absolute
  // (`/assets/...`). Bun's HTMLBundle re-bundler (used to embed the UI into the
  // `bun build --compile` binary) resolves `<link>`/`<script>` refs relative to
  // the HTML file on disk; root-absolute paths fail to resolve ("Could not
  // resolve /assets/...") whereas relative paths bundle + re-hash cleanly.
  // On-disk (dev/override) serving in app.ts handles both forms.
  base: "./",
  build: {
    // Match the backend's expected <binary-dir>/frontend/build layout.
    outDir: "build",
  },
  server: {
    proxy,
  },
});
