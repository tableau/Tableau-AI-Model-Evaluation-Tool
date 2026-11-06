/** Shipped content paths and dataset metadata, with an injectable settings store. */

import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledContentRoot, contentIsDir, contentReaddir, contentReadText, isCompiledBinary } from "@tableau-ai-eval/core";

const _PINNED_KEY = "pinned_runs";

/** Minimal settings store — the routes layer backs this with the SQLite db. */
export interface SettingsStore {
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): void;
}

/** Options for resolving the public suites root. */
export interface PublicContentEnv {
  /** TABLEAU_AI_EVAL_PUBLIC_SUITES override. */
  publicSuitesOverride?: string | null;
  /** Bundle/dev root (dirname(execPath) when compiled, else repo root). */
  bundleRoot?: string | null;
}

const isDir = contentIsDir;

/**
 * `public-suites/`: TABLEAU_AI_EVAL_PUBLIC_SUITES override → bundle/dev root →
 * (fallback) the module's project root. Returns absolute path or null.
 */
export function publicSuitesRoot(env: PublicContentEnv = {}): string | null {
  const override =
    env.publicSuitesOverride ?? process.env.TABLEAU_AI_EVAL_PUBLIC_SUITES ?? null;
  if (override) {
    const p = resolve(override);
    return isDir(p) ? p : null;
  }
  const p = join(contentBase(env), "public-suites");
  return isDir(p) ? p : null;
}

/** Where the content dirs live: the explicit `bundleRoot`, else the content
 * pack mounted in the compiled binary (falling back to the binary's dir), else
 * the repo root in dev. */
function contentBase(env: PublicContentEnv): string {
  if (env.bundleRoot) return env.bundleRoot;
  if (isCompiledBinary()) return bundledContentRoot() ?? dirname(process.execPath);
  return projectRootFromModule();
}

/** Repo root in dev. This module lives at
 * `packages/server/src/suites/public_content.ts`, and `public-suites/` sits at
 * the monorepo root, so walk up four levels (suites → src → server → packages →
 * root). fileURLToPath handles Windows drive-letter URLs (unlike
 * new URL(...).pathname). */
function projectRootFromModule(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "..", "..");
}


export function publicFixturesDir(env?: PublicContentEnv): string | null {
  const root = publicSuitesRoot(env);
  if (!root) return null;
  const p = join(root, "fixtures");
  return isDir(p) ? p : null;
}

export function publicFieldSearchDir(env?: PublicContentEnv): string | null {
  const root = publicSuitesRoot(env);
  if (!root) return null;
  const p = join(root, "field-search");
  return isDir(p) ? p : null;
}

// ---------------------------------------------------------------------------
// The datasets behind the Datasource column of the results page
// ---------------------------------------------------------------------------

/** How many sample values of a field the dataset panel is sent. */
const MAX_SAMPLE_VALUES = 8;

export interface DatasetSummary {
  id: string;
  name: string;
  field_count: number;
}

export interface DatasetField {
  name: string;
  description: string;
  role: string;
  datatype: string;
  default_aggregation: string;
  distinct_count: unknown;
  sample_values: unknown[];
  value_count: number;
}

export interface Dataset {
  id: string;
  name: string;
  fields: DatasetField[];
}

/**
 * Dataset identifier -> fixture file, for every dataset of the public pack. A
 * dataset is looked up in this map, never by building a path from the name a
 * request carries.
 */
function datasetFiles(fixturesDir: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!fixturesDir) return out;
  let names: string[];
  try {
    names = contentReaddir(fixturesDir);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
    out.set(name.slice(0, -".json".length), join(fixturesDir, name));
  }
  return out;
}

type RawDataset = { name?: unknown; fields: unknown[] };

function readDataset(path: string): RawDataset | null {
  let data: unknown;
  try {
    data = JSON.parse(contentReadText(path));
  } catch {
    return null;
  }
  return data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Array.isArray((data as RawDataset).fields)
    ? (data as RawDataset)
    : null;
}

/** The datasets the public suites ask about: id, display name, field count. */
export function listDatasets(fixturesDir: string | null = publicFixturesDir()): DatasetSummary[] {
  const out: DatasetSummary[] = [];
  for (const [id, path] of datasetFiles(fixturesDir)) {
    const data = readDataset(path);
    if (!data) continue;
    out.push({ id, name: (data.name as string) || id, field_count: data.fields.length });
  }
  return out;
}

/**
 * One dataset as the model is shown it: its fields, with their role, type,
 * description and a few sample values. The pack holds no rows.
 */
export function getDataset(
  identifier: string,
  fixturesDir: string | null = publicFixturesDir(),
): Dataset | null {
  const path = datasetFiles(fixturesDir).get(identifier);
  const data = path ? readDataset(path) : null;
  if (!data) return null;
  const fields: DatasetField[] = [];
  for (const raw of data.fields) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const f = raw as Record<string, unknown>;
    const values = Array.isArray(f.values) ? (f.values as unknown[]) : [];
    fields.push({
      name: (f.caption as string) || (f.name as string) || "",
      description: (f.description as string) || "",
      role: (f.role as string) || "",
      datatype: (f.datatype as string) || "",
      default_aggregation: (f.defaultAggregation as string) || "",
      distinct_count: f.distinctCount ?? null,
      sample_values: values.slice(0, MAX_SAMPLE_VALUES),
      value_count: values.length,
    });
  }
  return { id: identifier, name: (data.name as string) || identifier, fields };
}

/** True when a run's test path sits inside the public pack. */
export function isPublicPath(
  path: string | null | undefined,
  env?: PublicContentEnv,
): boolean {
  const root = publicSuitesRoot(env);
  if (!root || !path) return false;
  try {
    const rel = relative(resolve(root), resolve(path));
    // Inside root iff the relative path does not escape upward and is not absolute.
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}


/**
 * Run ids marked as pinned in history.
 */
export function pinnedRuns(store: SettingsStore | null): string[] {
  let ids: unknown = null;
  try {
    ids = store?.getSetting(_PINNED_KEY) ?? null;
  } catch {
    ids = null;
  }
  return Array.isArray(ids) ? ids.map((i) => String(i)) : [];
}

export function setPinnedRuns(
  store: SettingsStore,
  ids: unknown[],
): void {
  store.setSetting(
    _PINNED_KEY,
    ids.map((i) => String(i)),
  );
}
