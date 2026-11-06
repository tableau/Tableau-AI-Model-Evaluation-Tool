# Tableau AI Model Evaluation Tool frontend

React 18 and TypeScript, built with Vite. This package is a Bun workspace: root
`bun install` installs its dependencies and builds it. The server consumes the
build artifact, not frontend source imports.

## Development

Run `bun dev` from the repository root for backend and Vite HMR together, then
open `http://localhost:5173`. From this package, `bun run dev` starts only Vite;
API requests are proxied to the backend on `http://localhost:8000`.

## Build and tests

```sh
bun run build  # from this directory; output is build/index.html and build/assets/
```

From the repository root:

```sh
bun run scripts/build-frontend.ts
bunx tsc --noEmit -p packages/frontend/tsconfig.json
bun test packages/frontend
```

The backend serves the built UI and SPA fallback from one origin. Standalone
binaries embed the build. To use a different backend origin at build time, set
`VITE_API_BASE_URL`; otherwise the browser uses `window.location.origin`.

`src/metricCatalog.json` is synchronized from the shared core catalog by the
build script. Update `packages/core/src/metrics/catalog.json`, not the copy.
See [the development guide](../../docs/DEVELOPMENT.md) for full-stack builds,
configuration, and release packaging.
