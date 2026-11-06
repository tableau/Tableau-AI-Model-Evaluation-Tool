/**
 * The dashboard behind a Dashboard summaries case, for the results page.
 *
 * A case is one captured dashboard: its name, its views, the outliers and
 * insights Tableau detected in each view, and a picture of it. The results
 * page names the dashboard in each row and opens it in a side panel; this
 * module reads that from the case file the run used.
 *
 * The panel embeds the live dashboard when it knows where the dashboard is
 * published: the case may record that address (`info.source_url`), and an
 * admin may save one for a dashboard that does not (the `dashboard_locations`
 * setting, keyed by the case's `dashboardId`). Otherwise the panel
 * shows the case's picture.
 *
 * The case file is found from the run's own record: the folder the run read
 * its cases from, and the case id the row carries. Nothing outside that folder
 * is ever read — a case id is only ever looked up in an index of that folder's
 * files, never joined onto a path.
 */

import { join } from "node:path";
import { contentIsDir, contentReaddir, contentReadText, contentStamp } from "@tableau-ai-eval/core";

const PREFIX = "Dashboard Name: ";

/** The runner files a narrative case under "Dashboard Name: <name>". */
export function dashboardName(utterance: string | null | undefined): string {
  const text = (utterance || "").trim();
  return text.startsWith(PREFIX) ? text.slice(PREFIX.length).trim() : text;
}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Python's `rglob("*.json")`, sorted. */
function jsonFilesUnder(folder: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = contentReaddir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      if (contentIsDir(full)) walk(full);
      else if (name.endsWith(".json")) out.push(full);
    }
  };
  walk(folder);
  return out.sort();
}

// Case id -> file path for every case file under a folder, keyed by the
// folder and its modification time (a change to the folder drops the entry).
// Bounded to eight directories.
const INDEX_CACHE = new Map<string, Map<string, string>>();
const INDEX_CACHE_MAX = 8;

function index(folder: string, stamp: number): Map<string, string> {
  const key = `${folder}\u0000${stamp}`;
  const hit = INDEX_CACHE.get(key);
  if (hit) return hit;
  const out = new Map<string, string>();
  for (const path of jsonFilesUnder(folder)) {
    let doc: unknown;
    try {
      doc = JSON.parse(contentReadText(path));
    } catch {
      continue;
    }
    if (isObj(doc) && doc.id) out.set(String(doc.id), path);
  }
  if (INDEX_CACHE.size >= INDEX_CACHE_MAX) {
    const oldest = INDEX_CACHE.keys().next().value;
    if (oldest !== undefined) INDEX_CACHE.delete(oldest);
  }
  INDEX_CACHE.set(key, out);
  return out;
}

function caseFolder(run: { config?: unknown } | null | undefined): string | null {
  let config: unknown = run?.config ?? {};
  if (typeof config === "string") {
    try {
      config = JSON.parse(config);
    } catch {
      config = {};
    }
  }
  if (!isObj(config)) return null;
  const raw = config.test_path || config.test_cases_dir;
  if (!raw || typeof raw !== "string") return null;
  return contentIsDir(raw) ? raw : null;
}

function load(run: { config?: unknown } | null | undefined, caseId: string): Json | null {
  const folder = caseFolder(run);
  if (folder === null) return null;
  const stamp = contentStamp(folder);
  if (stamp === null) return null;
  // A row of a multi-input file is "<id>:<n>"; narrative files hold one.
  const path = index(folder, stamp).get(caseId.split(":")[0]!);
  if (!path) return null;
  try {
    const doc = JSON.parse(contentReadText(path));
    return isObj(doc) ? doc : null;
  } catch {
    return null;
  }
}

function args(doc: Json): Json {
  const inputs = Array.isArray(doc.inputs) && doc.inputs.length ? doc.inputs : [{}];
  const first = inputs[0];
  const a = isObj(first) ? first.arguments : null;
  return isObj(a) ? a : {};
}

function imageArtifact(a: Json): string | null {
  const list = Array.isArray(a.dashboardArtifacts) ? a.dashboardArtifacts : [];
  for (const artifact of list) {
    if (isObj(artifact) && artifact.artifactType === "IMAGE" && artifact.artifact) {
      return String(artifact.artifact);
    }
  }
  return null;
}

export interface DashboardView {
  name: string;
  outliers: number;
  insights: number;
}

export const LOCATIONS_SETTING = "dashboard_locations";

/**
 * The case's own id for its dashboard (the key a saved address is filed
 * under), or null when the case file is not on this machine.
 */
export function dashboardIdOf(
  run: { config?: unknown } | null | undefined,
  caseId: string,
): string | null {
  const doc = load(run, caseId);
  if (doc === null) return null;
  return String(args(doc).dashboardId || "") || null;
}

/** A dashboard address is a plain http(s) URL; nothing else is stored. */
export function validLocation(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\/[^\s/?#]+/.test(url.trim());
}

/**
 * The name the results page shows for a case's dashboard: the case's
 * `info.title` when it carries one (a dashboard sheet named "Home" or "main
 * page" says little on its own), else the dashboard's own name.
 */
export function titleOf(doc: Json): string {
  const info = isObj(doc.info) ? doc.info : {};
  return String(info.title || args(doc).dashboardName || "");
}

/**
 * Case id -> {name, title} for every case file the run read: the dashboard's
 * own name and the descriptive name to show for it.
 *.
 */
export function titles(
  run: { config?: unknown } | null | undefined,
): Record<string, { name: string; title: string }> {
  const folder = caseFolder(run);
  if (folder === null) return {};
  const stamp = contentStamp(folder);
  if (stamp === null) return {};
  const out: Record<string, { name: string; title: string }> = {};
  for (const [caseId, path] of index(folder, stamp)) {
    let doc: unknown;
    try {
      doc = JSON.parse(contentReadText(path));
    } catch {
      continue;
    }
    if (!isObj(doc)) continue;
    out[caseId] = { name: String(args(doc).dashboardName || ""), title: titleOf(doc) };
  }
  return out;
}

export interface DashboardInfo {
  id: string;
  dashboard_id: string | null;
  name: string;
  /** The descriptive name shown for the dashboard (the case's info.title), else the name. */
  title: string;
  views: DashboardView[];
  has_image: boolean;
  /**
   * Where the dashboard itself is published: recorded by the case ("case"),
   * saved by an admin ("saved"), or unknown (null).
   */
  url: string | null;
  url_source: "case" | "saved" | null;
  source: string | null;
}

/**
 * What the panel shows: the dashboard's name, its views with how many
 * outliers and insights each carries, whether there is a picture, and where
 * the dashboard is published (from the case, else from the saved `locations`).
 */
export function describe(
  run: { config?: unknown } | null | undefined,
  caseId: string,
  locations: Record<string, unknown> | null = null,
): DashboardInfo | null {
  const doc = load(run, caseId);
  if (doc === null) return null;
  const a = args(doc);
  const views: DashboardView[] = [];
  for (const view of Array.isArray(a.views) ? a.views : []) {
    if (!isObj(view)) continue;
    const kinds = (Array.isArray(view.artifacts) ? view.artifacts : [])
      .filter(isObj)
      .map((x) => x.artifactType);
    views.push({
      name: (view.name as string) || "",
      outliers: kinds.filter((k) => k === "OUTLIERS").length,
      insights: kinds.filter((k) => k === "PULSE_INSIGHTS").length,
    });
  }
  const info = isObj(doc.info) ? doc.info : {};
  const dashboardId = String(a.dashboardId || "") || null;
  const saved = dashboardId ? (locations || {})[dashboardId] : undefined;
  let url: string | null = null;
  let urlSource: DashboardInfo["url_source"] = null;
  if (info.source_url) {
    url = String(info.source_url);
    urlSource = "case";
  } else if (validLocation(saved)) {
    url = saved.trim();
    urlSource = "saved";
  }
  return {
    id: caseId,
    dashboard_id: dashboardId,
    name: (a.dashboardName as string) || "",
    title: titleOf(doc),
    views,
    has_image: imageArtifact(a) !== null,
    url,
    url_source: urlSource,
    source: (info.source as string) || null,
  };
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return bytes.length >= magic.length && magic.every((b, i) => bytes[i] === b);
}

/**
 * Python's `base64.b64decode(s)` (validate=False): characters outside the
 * alphabet are dropped, and bad padding is an error (null here).
 */
function b64decodeLikePython(s: string): Uint8Array | null {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, "");
  if (clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  return new Uint8Array(Buffer.from(clean, "base64"));
}

/** The dashboard's picture as (bytes, media type), or null. */
export function image(
  run: { config?: unknown } | null | undefined,
  caseId: string,
): { data: Uint8Array; mediaType: string } | null {
  const doc = load(run, caseId);
  if (doc === null) return null;
  const encoded = imageArtifact(args(doc));
  if (!encoded) return null;
  // A data URL ("data:image/png;base64,....") carries the payload after the comma.
  const raw = b64decodeLikePython(encoded.split(",").pop() ?? "");
  if (raw === null) return null;
  if (startsWith(raw, PNG_MAGIC)) return { data: raw, mediaType: "image/png" };
  if (startsWith(raw, JPEG_MAGIC)) return { data: raw, mediaType: "image/jpeg" };
  return null;
}
