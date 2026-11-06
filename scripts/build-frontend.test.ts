import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isFrontendStale } from "./build-frontend.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "tableau-ai-eval-frontend-test-"));
  dirs.push(root);
  return join(root, "packages", "frontend");
}

function write(directory: string, path: string, seconds: number, contents = "fixture"): void {
  const file = join(directory, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, contents);
  utimesSync(file, seconds, seconds);
}

test("frontend build is stale when missing, but not when newer than its inputs", () => {
  const directory = fixture();
  expect(isFrontendStale(directory)).toBe(true);
  write(directory, "src/NlqResultsPage.tsx", 100);
  write(directory, "build/index.html", 200);
  expect(isFrontendStale(directory)).toBe(false);
  write(directory, "build/assets/output.js", 300);
  expect(isFrontendStale(directory)).toBe(false);
});

test("even a whitespace-only frontend edit invalidates the build", () => {
  const directory = fixture();
  write(directory, "src/NlqResultsPage.tsx", 100, "export {};\n");
  write(directory, "build/index.html", 200);
  expect(isFrontendStale(directory)).toBe(false);
  write(directory, "src/NlqResultsPage.tsx", 300, "\nexport {};\n");
  expect(isFrontendStale(directory)).toBe(true);
});

test("static assets, build configuration and the workspace lockfile invalidate the build", () => {
  for (const input of ["public/logo.png", "index.html", "vite.config.ts", "tsconfig.json", "tsconfig.node.json", "package.json", "../../bun.lock"]) {
    const directory = fixture();
    write(directory, "build/index.html", 200);
    write(directory, input, 300);
    expect(isFrontendStale(directory)).toBe(true);
  }
});
