/**
 * The consumers read the same content from the mounted pack (compiled binary)
 * as from the checkout's plain files (`bun start`/`bun dev`): pack the real
 * repo content in memory, mount it, and compare.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ContentPack, contentReadBytes, mountContentPack } from "@tableau-ai-eval/core";
import { createCabuSuiteLoader, flattenPrepSuite, paletteAdapter } from "@tableau-ai-eval/evals";
import { CONTENT_DICTIONARY, packContent } from "../../../../scripts/bundle-content.ts";
import { listSuites } from "./catalog.ts";
import { getPrepDataset, listPrepDatasets } from "./prep_datasets.ts";
import { getDataset, listDatasets } from "./public_content.ts";
import { suiteContent } from "./dashboard_content.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..");
const MOUNT = join(REPO, "<bundled-test>");
const DIRS = ["public-suites", "prep-bench"];

beforeAll(() => {
  const parts = packContent(REPO, readFileSync(join(REPO, CONTENT_DICTIONARY)), DIRS);
  mountContentPack(ContentPack.open(parts), MOUNT);
});
afterAll(() => mountContentPack(null));

const at = (base: string) => ({
  publicBase: join(base, "public-suites"),
  prepBase: join(base, "public-suites", "prep"),
});

test("suite catalog and case counts match", () => {
  const strip = (base: string) =>
    listSuites(at(base)).map((s) => ({ ...s, path: s.path ? s.path.slice(base.length) : s.path }));
  const plain = strip(REPO);
  expect(plain.some((s) => s.available && s.case_count > 0)).toBe(true);
  expect(strip(MOUNT)).toEqual(plain);
});

test("datasets panel matches", () => {
  const fixtures = (base: string) => join(base, "public-suites", "fixtures");
  const plain = listDatasets(fixtures(REPO));
  expect(plain.length).toBeGreaterThan(0);
  expect(listDatasets(fixtures(MOUNT))).toEqual(plain);
  expect(getDataset(plain[0]!.id, fixtures(MOUNT))).toEqual(getDataset(plain[0]!.id, fixtures(REPO)));
});

test("prep bench cases and datasets match", () => {
  const bench = (base: string) => join(base, "prep-bench");
  for (const kind of ["calc-gen", "flow-plan-gen", "intent-gen"] as const) {
    const dir = (base: string) => join(base, "public-suites", "prep", kind);
    expect(flattenPrepSuite(dir(MOUNT), kind)).toEqual(flattenPrepSuite(dir(REPO), kind));
  }
  const plain = listPrepDatasets(bench(REPO));
  expect(plain.length).toBeGreaterThan(0);
  expect(listPrepDatasets(bench(MOUNT))).toEqual(plain);
  expect(getPrepDataset(plain[0]!.id, bench(MOUNT))).toEqual(getPrepDataset(plain[0]!.id, bench(REPO)));
});

test("palette cases match", () => {
  const palettes = (base: string) => join(base, "public-suites", "color-palette");
  expect(paletteAdapter.loadCases(palettes(MOUNT))).toEqual(paletteAdapter.loadCases(palettes(REPO)));
});

// Questions about a dashboard is held back from this release; its content
// folder is out of the tree, so these two checks run only when it is back.
const QA_CONTENT_PRESENT = existsSync(join(REPO, "public-suites", "dashboard-qa"));

test.skipIf(!QA_CONTENT_PRESENT)("dashboard Q&A cases match", async () => {
  const load = createCabuSuiteLoader();
  const suites = (base: string) => join(base, "public-suites", "dashboard-qa", "cases");
  const cases = await load({ test_path: "cabu_superstore", cabu_suites_root: suites(REPO) });
  expect(cases.length).toBeGreaterThan(0);
  expect(await load({ test_path: "cabu_superstore", cabu_suites_root: suites(MOUNT) })).toEqual(cases);
});

test.skipIf(!QA_CONTENT_PRESENT)("dashboard datasource files (.tdsx, stored raw) read back byte for byte", () => {
  const plain = suiteContent("dashboard-qa-superstore", { publicBase: join(REPO, "public-suites") })!;
  const packed = suiteContent("dashboard-qa-superstore", { publicBase: join(MOUNT, "public-suites") })!;
  expect(plain.datasources.length).toBeGreaterThan(0);
  for (const [i, ds] of plain.datasources.entries()) {
    const twin = packed.datasources[i]!;
    expect(ds.present).toBe(true);
    expect(twin.present).toBe(true);
    expect(Buffer.from(contentReadBytes(twin.path!)).equals(readFileSync(ds.path!))).toBe(true);
  }
});
