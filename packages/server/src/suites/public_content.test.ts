import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  publicSuitesRoot,
  publicFixturesDir,
  publicFieldSearchDir,
  isPublicPath,
  pinnedRuns,
  setPinnedRuns,
  listDatasets,
  getDataset,
  type SettingsStore,
} from "./public_content.ts";

const ROOT = join(tmpdir(), `tableau-ai-eval-public-content-${process.pid}`);
const SUITES = join(ROOT, "public-suites");

beforeAll(() => {
  mkdirSync(join(SUITES, "fixtures"), { recursive: true });
  mkdirSync(join(SUITES, "field-search"), { recursive: true });
  mkdirSync(join(SUITES, "calcs", "cases"), { recursive: true });
  writeFileSync(join(SUITES, "calcs", "cases", "a.json"), "{}");
});

afterAll(() => {
  try {
    rmSync(ROOT, { recursive: true, force: true });
  } catch {}
});

/** In-memory settings store. */
function memStore(init: Record<string, unknown> = {}): SettingsStore {
  const m = new Map<string, unknown>(Object.entries(init));
  return {
    getSetting: (k) => m.get(k) ?? null,
    setSetting: (k, v) => {
      m.set(k, v);
    },
  };
}

test("publicSuitesRoot: env override wins, resolved absolute", () => {
  const root = publicSuitesRoot({ publicSuitesOverride: SUITES });
  expect(root).toBe(SUITES);
});

test("publicSuitesRoot: bundle root fallback", () => {
  const root = publicSuitesRoot({ bundleRoot: ROOT });
  expect(root).toBe(SUITES);
});

test("publicSuitesRoot: null when missing", () => {
  expect(publicSuitesRoot({ publicSuitesOverride: join(ROOT, "nope") })).toBe(null);
  expect(publicSuitesRoot({ bundleRoot: join(ROOT, "nope") })).toBe(null);
});

test("publicSuitesRoot: dev fallback resolves to the repo-root public-suites", () => {
  // No env / no injected bundleRoot: running from source must find the
  // monorepo-root `public-suites/` (regression — the module lives at
  // packages/server/src/suites, so the walk-up depth must reach the repo root,
  // not packages/server). Otherwise every public suite reads unavailable and
  // the UI greys out Evaluate in dev.
  const root = publicSuitesRoot();
  expect(root).not.toBeNull();
  expect(root!.endsWith(`${sep}public-suites`)).toBe(true);
});

test("publicFixturesDir + publicFieldSearchDir", () => {
  const env = { publicSuitesOverride: SUITES };
  expect(publicFixturesDir(env)).toBe(join(SUITES, "fixtures"));
  expect(publicFieldSearchDir(env)).toBe(join(SUITES, "field-search"));
});


test("isPublicPath: inside vs outside the pack", () => {
  const env = { publicSuitesOverride: SUITES };
  expect(isPublicPath(join(SUITES, "calcs", "cases", "a.json"), env)).toBe(true);
  expect(isPublicPath(join(ROOT, "elsewhere.json"), env)).toBe(false);
  expect(isPublicPath(null, env)).toBe(false);
});

test("pinnedRuns round-trip", () => {
  const store = memStore();

  expect(pinnedRuns(store)).toEqual([]);
  setPinnedRuns(store, [1, "abc", 2]);
  expect(pinnedRuns(store)).toEqual(["1", "abc", "2"]);
});

// ---------------------------------------------------------------------------
// The datasets behind the Datasource column of the results page,
// read from the repo's shipped public pack.
// ---------------------------------------------------------------------------

const REPO_FIXTURES = join(import.meta.dir, "..", "..", "..", "..", "public-suites", "fixtures");

test("every public dataset is listed with its fields", () => {
  const listed = listDatasets(REPO_FIXTURES);
  const ids = new Set(listed.map((d) => d.id));
  for (const id of ["public-account-360", "chicago-taxi-trips-2024-calcs", "retail-nto"]) {
    expect(ids.has(id)).toBe(true);
  }
  expect(listed.every((d) => d.name && d.field_count > 0)).toBe(true);
});

test("a dataset is returned as fields with a few sample values", () => {
  const body = getDataset("public-account-360", REPO_FIXTURES)!;
  expect(body.name).toBe("Data Depot · Account 360");
  expect(body.fields.length).toBe(67);
  const first = body.fields[0]!;
  expect(first.name).toBe("Account Name");
  expect(first.role).toBe("dimension");
  expect(first.datatype).toBe("string");
  expect(first.sample_values.length).toBeGreaterThan(0);
  expect(first.sample_values.length).toBeLessThanOrEqual(8);
  expect(first.value_count).toBeGreaterThanOrEqual(8);
});

test("an unknown dataset or a path is not served", () => {
  expect(getDataset("no-such-dataset", REPO_FIXTURES)).toBeNull();
  // Only names of the pack's own files resolve; a path never reaches the disk.
  expect(getDataset("../../packages/core/src/metrics/catalog", REPO_FIXTURES)).toBeNull();
  expect(getDataset("/etc/passwd", REPO_FIXTURES)).toBeNull();
  expect(listDatasets(null)).toEqual([]);
});

test("the public pack is self-contained", () => {
  // Every datasource a public case names has a fixture in the shared
  // directory. Color palettes cases ask about no data and name none;
  // Dashboard summaries cases carry the dashboard (picture, views, detected
  // insights) themselves.
  const root = join(REPO_FIXTURES, "..");
  const have = new Set(readdirSync(REPO_FIXTURES).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)));
  const cases: Record<string, unknown>[] = [];
  const walk = (dir: string, underCases: boolean): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full, underCases || name === "cases");
      else if (underCases && name.endsWith(".json")) cases.push(JSON.parse(readFileSync(full, "utf-8")));
    }
  };
  walk(root, false);
  const palette = (c: Record<string, unknown>) => c.runner === "color-palettes-server";
  const dataFree = (c: Record<string, unknown>) =>
    palette(c) || c.runner === "dashboard-viz-narrative-config";
  const missing = cases.filter((c) => !dataFree(c)).map((c) => c.datasource as string).filter((d) => !have.has(d));
  expect([...new Set(missing)]).toEqual([]);
  expect(cases.filter(palette).length).toBe(34);
  expect(cases.some((c) => dataFree(c) && "datasource" in c)).toBe(false);
});
