/**
 * Dev launcher: run the backend (API on :8000) and the Vite dev server (HMR UI
 * on :5173) together, so frontend edits hot-reload with no build step.
 *
 * Open the VITE url (http://localhost:5173). Vite proxies the API prefixes
 * (`/nlq-eval/*`, …) to the backend on :8000 — see packages/frontend/vite.config.ts.
 * The backend serves no UI in this mode: UI requests to :8000 redirect to Vite
 * (TABLEAU_AI_EVAL_DEV_UI_URL), so an old `packages/frontend/build` is never shown.
 * (`bun start` is the other mode: single-origin, serves the built UI + API on
 * :8000; this command is for iterating on the frontend.)
 *
 * Lifecycle: Ctrl-C (SIGINT/SIGTERM) tears down BOTH children; if either exits
 * on its own, the other is killed too, so there is never a half-running dev env.
 *
 * Usage: `bun dev`  (forwards nothing; set TABLEAU_AI_EVAL_PORT to move the backend, but
 * then also update vite.config.ts's proxy target.)
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Subprocess } from "bun";
import { generateCalcParser } from "./generate-calc-parser.ts";
import { generatePrepParser } from "./generate-prep-parser.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const frontendDir = join(root, "packages", "frontend");
const backendEntry = join(root, "packages", "server", "src", "cli.ts");
const bun = process.execPath;

await generateCalcParser();
await generatePrepParser();

/** Prefix every line of a child's stream with a label, teed to our stdout. */
function pipeWithLabel(stream: ReadableStream<Uint8Array>, label: string): void {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const pump = async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) process.stdout.write(`${label} ${line}\n`);
    }
    if (buf) process.stdout.write(`${label} ${buf}\n`);
  };
  void pump();
}

const children: Subprocess[] = [];
let shuttingDown = false;

function shutdown(code = 0): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    try {
      c.kill();
    } catch {}
  }
  process.exit(code);
}

const VITE_PORT = 5173;

function spawnLabeled(
  label: string,
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined> = process.env,
): Subprocess {
  const child = Bun.spawn(cmd, {
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "inherit",
  });
  pipeWithLabel(child.stdout as ReadableStream<Uint8Array>, label);
  pipeWithLabel(child.stderr as ReadableStream<Uint8Array>, label);
  // If either child exits, take the whole dev env down.
  void child.exited.then((exitCode) => {
    if (!shuttingDown) {
      process.stdout.write(`\n${label} exited (code ${exitCode}); stopping dev.\n`);
      shutdown(exitCode ?? 0);
    }
  });
  return child;
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

process.stdout.write(
  `Starting dev: backend on :8000, Vite (HMR) on :${VITE_PORT}.\n` +
    `→ open http://localhost:${VITE_PORT}  (API proxies to :8000; UI requests to :8000 redirect here)\n\n`,
);

children.push(
  spawnLabeled("[backend]", [bun, "run", backendEntry, "serve"], root, {
    ...process.env,
    TABLEAU_AI_EVAL_DEV_UI_URL: `http://localhost:${VITE_PORT}`,
  }),
);
// --strictPort: fail instead of silently moving to another port, which would
// break the backend's redirect target.
children.push(
  spawnLabeled("[vite]", [bun, "run", "vite", "--port", String(VITE_PORT), "--strictPort"], frontendDir),
);
