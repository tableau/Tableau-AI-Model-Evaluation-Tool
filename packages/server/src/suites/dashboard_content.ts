/**
 * Sample content for the Questions about a dashboard suites,
 * driven by the bundled content manifest.
 *
 * Each suite asks about one dashboard on the connected site. The content
 * ships with the tool: a datasource file (.tdsx) per data source in
 * `public-suites/dashboard-qa/content/` and a manifest, `content.json`, that
 * says which files a suite uses and what the workbook and dashboard are
 * called. The workbook itself is generated here at publish time (one sheet
 * per data source, one dashboard holding them), because it has to point at
 * the published data sources of the site it is published to.
 *
 * Publishing goes through the Tableau REST API with the stored connection,
 * into the project the manifest names. The ids the server hands back are
 * remembered per site and suite, so a run never asks for them. `PLACEHOLDER`
 * ids in the suite YAML are replaced from this memory at run time (see
 * `routes/dashboard_content.ts mergeDashboardContent`).
 */

import { basename, extname, join } from "node:path";
import {
  contentIsFile,
  contentReadBytes,
  contentReadText,
  type FetchLike,
  type TableauSession,
  tlsInit,
} from "@tableau-ai-eval/core";
import { publicSuitesRoot, type SettingsStore } from "./public_content.ts";

export const API_VERSION = "3.22";
export const SETTING_KEY = "dashboard_qa_content";
const CONTENT_DIR = "dashboard-qa";
const MANIFEST_NAME = "content.json";
const DEFAULT_PROJECT = "AI Model Evaluation Samples";

type Json = Record<string, unknown>;

export interface SheetSpec {
  dimension: string;
  measure: string;
  measure_type?: string;
}

export interface ContentDatasource {
  file: string;
  name: string;
  luid_key?: string;
  display_name?: string;
  sheet: SheetSpec;
  /** Absolute path of the .tdsx, or null when the pack is not on this machine. */
  path: string | null;
  present: boolean;
}

export interface SuiteContent {
  workbook: { name: string; dashboard: string; luid_key?: string };
  datasources: ContentDatasource[];
  project: string;
}

/** Where the manifest is looked for (tests point it at a staged pack). */
export interface ContentEnv {
  /** `public-suites/` root; default `publicSuitesRoot()`. */
  publicBase?: string | null;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

const isFile = contentIsFile;

/** `public-suites/dashboard-qa` when the public pack is present. */
export function contentRoot(env: ContentEnv = {}): string | null {
  const root = env.publicBase !== undefined ? env.publicBase : publicSuitesRoot();
  if (!root) return null;
  const p = join(root, CONTENT_DIR);
  return isFile(join(p, MANIFEST_NAME)) ? p : null;
}

export function loadManifest(env: ContentEnv = {}): {
  project?: string;
  suites?: Record<string, Json>;
} {
  const root = contentRoot(env);
  if (root === null) return { project: DEFAULT_PROJECT, suites: {} };
  return JSON.parse(contentReadText(join(root, MANIFEST_NAME)));
}

/**
 * The resolved manifest entry for a suite (`same_as` followed), with absolute
 * `path` on every datasource, or null when the suite has none.
 */
export function suiteContent(suiteId: string, env: ContentEnv = {}): SuiteContent | null {
  const manifest = loadManifest(env);
  const suites = manifest.suites || {};
  let entry: unknown = Object.hasOwn(suites, suiteId) ? suites[suiteId] : undefined;
  const seen = new Set<string>();
  while (entry && typeof entry === "object" && (entry as Json).same_as) {
    const next = String((entry as Json).same_as);
    if (seen.has(next)) return null;
    seen.add(next);
    entry = Object.hasOwn(suites, next) ? suites[next] : undefined;
  }
  if (!entry || typeof entry !== "object" || !Array.isArray((entry as Json).datasources))
    return null;
  if (((entry as Json).datasources as unknown[]).length === 0) return null;
  const root = contentRoot(env);
  const out = JSON.parse(JSON.stringify(entry)) as SuiteContent;
  out.project = manifest.project || DEFAULT_PROJECT;
  for (const ds of out.datasources) {
    ds.path = root ? join(root, "content", ds.file) : null;
    ds.present = Boolean(ds.path && isFile(ds.path));
  }
  return out;
}

export function suitesWithContent(env: ContentEnv = {}): string[] {
  return Object.keys(loadManifest(env).suites || {}).sort();
}

// ---------------------------------------------------------------------------
// Remembered ids
// ---------------------------------------------------------------------------

export interface PublishedDatasource {
  luid: string;
  name: string;
  content_url: string;
  display_name?: string | null;
  luid_key?: string | null;
  file?: string;
}

export interface PublishedContent {
  workbook_luid: string;
  workbook_name?: string;
  workbook_content_url?: string;
  dashboard?: string;
  project?: string;
  datasources: PublishedDatasource[];
  published_at?: string;
}

function connectionKey(server: string, site: string): string {
  return `${(server || "").trim().replace(/\/+$/, "").toLowerCase()}|${(site || "").trim()}`;
}

function allStored(store: SettingsStore): Record<string, Record<string, Json>> {
  const v = store.getSetting(SETTING_KEY);
  return v && typeof v === "object" ? (v as Record<string, Record<string, Json>>) : {};
}

/** The ids remembered for this suite on this site, or {}. */
export function storedContent(
  store: SettingsStore,
  server: string,
  site: string,
  suiteId: string,
): Json {
  const perSite = allStored(store)[connectionKey(server, site)] || {};
  return { ...((Object.hasOwn(perSite, suiteId) ? perSite[suiteId] : null) || {}) };
}

export function storedContentForSite(
  store: SettingsStore,
  server: string,
  site: string,
): Record<string, Json> {
  return { ...(allStored(store)[connectionKey(server, site)] || {}) };
}

export function rememberContent(
  store: SettingsStore,
  server: string,
  site: string,
  suiteId: string,
  ids: Json,
): void {
  const stored = allStored(store);
  const key = connectionKey(server, site);
  stored[key] = { ...(stored[key] || {}), [suiteId]: ids };
  store.setSetting(SETTING_KEY, stored);
}

export function forgetContent(
  store: SettingsStore,
  server: string,
  site: string,
  suiteId: string,
): void {
  const stored = allStored(store);
  const key = connectionKey(server, site);
  const perSite = { ...(stored[key] || {}) };
  delete perSite[suiteId];
  stored[key] = perSite;
  store.setSetting(SETTING_KEY, stored);
}

/**
 * What a run needs from the memory: the workbook id and, in manifest order,
 * one entry per data source. {} when nothing is remembered.
 */
/**
 * Whether the remembered publish is of the content the manifest describes now:
 * the same workbook name and dashboard, the same files published under the
 * same names, in order. A suite whose sample content changed since it was
 * published is published again rather than asked about the
 * old data. A record without those details (older, or a test's) counts as
 * current.
 */
export function rememberedContentIsCurrent(suiteId: string, ids: Json, env: ContentEnv = {}): boolean {
  const content = suiteContent(suiteId, env);
  if (content === null || !ids || !Object.keys(ids).length) return false;
  const remembered = Array.isArray(ids.datasources) ? (ids.datasources as Json[]) : [];
  if (!remembered.length || !remembered.every((d) => d && typeof d === "object" && d.file)) return true;
  const want = content.datasources.map((d) => `${d.file}\u0000${d.name}`);
  const have = remembered.map((d) => `${d.file}\u0000${d.name}`);
  if (want.length !== have.length || want.some((w, i) => w !== have[i])) return false;
  if (ids.workbook_name && ids.workbook_name !== content.workbook.name) return false;
  if (ids.dashboard && ids.dashboard !== content.workbook.dashboard) return false;
  return true;
}

export function runIdsFor(
  store: SettingsStore,
  suiteId: string,
  server: string,
  site: string,
): Json {
  const ids = storedContent(store, server, site, suiteId);
  const datasources = Array.isArray(ids.datasources) ? (ids.datasources as Json[]) : [];
  if (!ids.workbook_luid || datasources.length === 0) return {};
  return {
    workbook_luid: ids.workbook_luid,
    datasource_luids: datasources.map((d) => d.luid),
    datasource_names: datasources.map((d) => d.display_name || d.name || null),
    datasource_luid: datasources[0]!.luid,
    datasource_name: datasources[0]!.display_name || datasources[0]!.name || null,
    datasource_label: datasources.map((d) => d.name || d.display_name || d.luid).join(" and "),
  };
}

/** Remembered content may have been deleted by an admin since the last run. */
export async function workbookExists(
  session: TableauSession,
  luid: string,
  opts: {
    verify?: boolean;
    caBundlePath?: string;
    fetchImpl?: FetchLike;
  } = {},
): Promise<boolean> {
  if (!luid) return false;
  try {
    const token = await session.getToken();
    const siteId = await session.siteId();
    const response = await (opts.fetchImpl || fetch)(
      `${session.serverUrl}/api/${API_VERSION}/sites/${siteId}/workbooks/${luid}`,
      {
        headers: { "X-Tableau-Auth": token, Accept: "application/json" },
        signal: AbortSignal.timeout(30000),
        ...tlsInit({ verify: opts.verify ?? true, caBundlePath: opts.caBundlePath }),
      },
    );
    return response.status !== 404;
  } catch {
    // A network outage is not evidence of deletion; the question reports it.
    return true;
  }
}

function fieldFiles(env: ContentEnv): Map<string, string> {
  const out = new Map<string, string>();
  const root = contentRoot(env);
  if (!root) return out;
  for (const id of suitesWithContent(env)) {
    for (const ds of suiteContent(id, env)?.datasources || []) {
      const path = join(root, "content", "fields", basename(ds.file, extname(ds.file)) + ".json");
      if (!isFile(path)) continue;
      for (const label of [ds.name, ds.display_name])
        if (label && !out.has(label)) out.set(label, path);
    }
  }
  return out;
}

/**
 * The shipped `.tdsx` behind a Q&A dataset label, when the tool has it: the
 * results page reads the extract's first rows from it (bug bash 2026-10-23).
 */
export function dashboardDatasetFile(label: string, env: ContentEnv = {}): string | null {
  const root = contentRoot(env);
  if (!root) return null;
  for (const id of suitesWithContent(env)) {
    for (const ds of suiteContent(id, env)?.datasources || []) {
      if (ds.name !== label && ds.display_name !== label) continue;
      const path = join(root, "content", ds.file);
      if (contentIsFile(path)) return path;
    }
  }
  return null;
}

/** Field descriptions are captured from the extracts and ship with the tool. */
export function listDashboardDatasets(env: ContentEnv = {}): Json[] {
  const out: Json[] = [];
  for (const [label, path] of fieldFiles(env)) {
    try {
      const data = JSON.parse(contentReadText(path)) as Json;
      out.push({
        id: label,
        name: data.name || label,
        field_count: Array.isArray(data.fields) ? data.fields.length : 0,
      });
    } catch {
      /* skip malformed descriptions */
    }
  }
  return out;
}

export function getDashboardDataset(label: string, env: ContentEnv = {}): Json | null {
  const path = fieldFiles(env).get(label);
  if (!path) return null;
  try {
    const data = JSON.parse(contentReadText(path)) as Json;
    const fields = (Array.isArray(data.fields) ? data.fields : []).map((f: Json) => {
      const values = Array.isArray(f.values) ? f.values : [];
      return {
        name: f.caption || f.name || "",
        description: "",
        role: f.role || "",
        datatype: f.datatype || "",
        default_aggregation: "",
        distinct_count: f.distinctCount,
        sample_values: values.slice(0, 8),
        value_count: f.distinctCount || values.length,
      };
    });
    // What this data is (origin, span, what the questions ask): the panel
    // shows it above the fields.
    return {
      id: label, name: data.name || label, fields, rows: data.rows, note: data.description || null,
      // The page offers the first rows when the extract ships with the tool.
      has_rows: dashboardDatasetFile(label, env) !== null,
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Workbook generation
// ---------------------------------------------------------------------------

/** XML text escaping — mirrors xml.sax.saxutils.escape. */
function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** XML attribute quoting — mirrors xml.sax.saxutils.quoteattr. */
function quoteAttr(value: string): string {
  let s = escapeXml(value).replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");
  if (s.includes('"')) {
    if (s.includes("'")) s = s.replace(/"/g, "&quot;");
    else return `'${s}'`;
  }
  return `"${s}"`;
}

function tableauDatatype(kind: string): string {
  return ["string", "real", "integer", "date"].includes(kind) ? kind : "string";
}

function shortHex(n: number): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, n);
}

export interface WorkbookDatasource {
  /** Shown in the workbook. */
  caption: string;
  /** The published data source's contentUrl. */
  content_url: string;
  sheet: { dimension: string; measure: string };
  /** `real` by default. */
  measure_type?: string | null;
}

/**
 * A workbook with one bar-chart sheet per published data source and one
 * dashboard showing every sheet.
 */
export function buildWorkbookXml(
  serverUrl: string,
  siteContentUrl: string,
  dashboardName: string,
  datasources: WorkbookDatasource[],
): string {
  let host = serverUrl;
  let scheme = "https";
  let port: number;
  try {
    const u = new URL(serverUrl);
    host = u.hostname || serverUrl;
    scheme = u.protocol.replace(/:$/, "") || "https";
    port = u.port ? Number(u.port) : scheme === "https" ? 443 : 80;
  } catch {
    port = 443;
  }
  const site = siteContentUrl || "";
  const dsPath = site ? `/t/${site}/datasources` : "/datasources";

  const dsBlocks: string[] = [];
  const sheetBlocks: string[] = [];
  const zoneBlocks: string[] = [];
  const windowBlocks: string[] = [];
  const viewpointBlocks: string[] = [];
  const sheetH = Math.floor(100000 / Math.max(1, datasources.length));
  datasources.forEach((ds, i) => {
    const name = `sqlproxy.${shortHex(26)}`;
    const caption = ds.caption;
    const contentUrl = ds.content_url;
    const dim = ds.sheet.dimension;
    const measure = ds.sheet.measure;
    const measureType = tableauDatatype(ds.measure_type || "real");
    const derived = `${serverUrl.replace(/\/+$/, "")}${dsPath}/${contentUrl}?rev=1.0`;
    dsBlocks.push(
      `    <datasource caption=${quoteAttr(caption)} inline='true' name='${name}' version='18.1'>\n` +
        `      <repository-location derived-from=${quoteAttr(derived)} id=${quoteAttr(contentUrl)} ` +
        `path=${quoteAttr(dsPath)} revision='1.0' site=${quoteAttr(site)} />\n` +
        `      <connection channel='${scheme}' class='sqlproxy' dbname=${quoteAttr(contentUrl)} ` +
        `port='${port}' server=${quoteAttr(host)} username='' workgroup-auth-mode='prompt'>\n` +
        "        <relation name='sqlproxy' table='[sqlproxy]' type='table' />\n" +
        "      </connection>\n" +
        "      <aliases enabled='yes' />\n" +
        `      <column datatype='string' name=${quoteAttr(`[${dim}]`)} role='dimension' type='nominal' />\n` +
        `      <column datatype='${measureType}' name=${quoteAttr(`[${measure}]`)} role='measure' type='quantitative' />\n` +
        "      <layout dim-ordering='alphabetic' measure-ordering='alphabetic' show-structure='true' />\n" +
        "    </datasource>\n",
    );
    const sheet = `Sheet ${i + 1}`;
    const dimInst = `[none:${dim}:nk]`;
    const measInst = `[sum:${measure}:qk]`;
    sheetBlocks.push(
      `    <worksheet name=${quoteAttr(sheet)}>\n` +
        `      <layout-options><title><formatted-text><run>${escapeXml(measure)} by ${escapeXml(dim)}</run></formatted-text></title></layout-options>\n` +
        "      <table>\n" +
        "        <view>\n" +
        "          <datasources>\n" +
        `            <datasource caption=${quoteAttr(caption)} name='${name}' />\n` +
        "          </datasources>\n" +
        `          <datasource-dependencies datasource='${name}'>\n` +
        `            <column datatype='string' name=${quoteAttr(`[${dim}]`)} role='dimension' type='nominal' />\n` +
        `            <column datatype='${measureType}' name=${quoteAttr(`[${measure}]`)} role='measure' type='quantitative' />\n` +
        `            <column-instance column=${quoteAttr(`[${dim}]`)} derivation='None' name=${quoteAttr(dimInst)} pivot='key' type='nominal' />\n` +
        `            <column-instance column=${quoteAttr(`[${measure}]`)} derivation='Sum' name=${quoteAttr(measInst)} pivot='key' type='quantitative' />\n` +
        "          </datasource-dependencies>\n" +
        "          <aggregation value='true' />\n" +
        "        </view>\n" +
        "        <style />\n" +
        "        <panes>\n" +
        "          <pane>\n" +
        "            <view><breakdown value='auto' /></view>\n" +
        "            <mark class='Bar' />\n" +
        "          </pane>\n" +
        "        </panes>\n" +
        `        <rows>${escapeXml(`[${name}].${dimInst}`)}</rows>\n` +
        `        <cols>${escapeXml(`[${name}].${measInst}`)}</cols>\n` +
        "      </table>\n" +
        "    </worksheet>\n",
    );
    zoneBlocks.push(
      `            <zone h='${sheetH}' id='${10 + i}' name=${quoteAttr(sheet)} w='100000' x='0' y='${i * sheetH}' />\n`,
    );
    windowBlocks.push(
      `    <window class='worksheet' name=${quoteAttr(sheet)}>\n` +
        "      <cards>\n" +
        "        <edge name='left'><strip size='160'><card type='pages' /><card type='filters' /><card type='marks' /></strip></edge>\n" +
        "        <edge name='top'><strip size='2147483647'><card type='columns' /></strip><strip size='2147483647'><card type='rows' /></strip><strip size='2147483647'><card type='title' /></strip></edge>\n" +
        "      </cards>\n" +
        "    </window>\n",
    );
    viewpointBlocks.push(
      `        <viewpoint name=${quoteAttr(sheet)}><zoom type='entire-view' /></viewpoint>\n`,
    );
  });

  return (
    "<?xml version='1.0' encoding='utf-8' ?>\n" +
    "<workbook original-version='18.1' source-platform='mac' version='18.1' " +
    "xmlns:user='http://www.tableausoftware.com/xml/user'>\n" +
    "  <document-format-change-manifest>\n" +
    "    <ObjectModelEncapsulateLegacy />\n" +
    "    <ObjectModelTableType />\n" +
    "    <SheetIdentifierTracking />\n" +
    "  </document-format-change-manifest>\n" +
    "  <preferences>\n" +
    "    <preference name='ui.encoding.shelf.height' value='24' />\n" +
    "    <preference name='ui.shelf.height' value='26' />\n" +
    "  </preferences>\n" +
    `  <datasources>\n${dsBlocks.join("")}  </datasources>\n` +
    `  <worksheets>\n${sheetBlocks.join("")}  </worksheets>\n` +
    "  <dashboards>\n" +
    `    <dashboard name=${quoteAttr(dashboardName)}>\n` +
    "      <style />\n" +
    "      <size maxheight='800' maxwidth='1000' minheight='800' minwidth='1000' />\n" +
    "      <zones>\n" +
    "        <zone h='100000' id='4' type-v2='layout-basic' w='100000' x='0' y='0'>\n" +
    "          <zone h='100000' id='5' param='vert' type-v2='layout-flow' w='100000' x='0' y='0'>\n" +
    zoneBlocks.join("") +
    "          </zone>\n" +
    "        </zone>\n" +
    "      </zones>\n" +
    "    </dashboard>\n" +
    "  </dashboards>\n" +
    `  <windows>\n${windowBlocks.join("")}` +
    `    <window class='dashboard' maximized='true' name=${quoteAttr(dashboardName)}>\n` +
    `      <viewpoints>\n${viewpointBlocks.join("")}      </viewpoints>\n` +
    "      <active id='-1' />\n" +
    "    </window>\n" +
    "  </windows>\n" +
    "</workbook>\n"
  );
}

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** A publishing step failed; the message is for the admin. */
export class ContentPublishError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentPublishError";
  }
}

/** The session surface the publisher needs (a `TableauSession`, or a test fake). */
export type PublisherSession = Pick<TableauSession, "serverUrl" | "siteId" | "authHeaders">;

export interface ContentPublisherOptions {
  verify?: boolean;
  caBundlePath?: string;
  fetchImpl?: FetchLike;
  /** Injected by tests; the publish retries wait with it. */
  sleepImpl?: (ms: number) => Promise<void>;
}

// A publish that fails on the server's side (5xx, a dropped connection) is
// tried again after these waits: a Cloud site's front door reset the
// connection mid-upload and failed a 1,019-question run before its first
// question (2026-10-21).
const PUBLISH_RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/** Assemble a multipart/mixed body (the REST publish endpoints reject form-data). */
export function multipartMixed(
  payloadXml: string,
  partName: string,
  fileName: string,
  fileBytes: Uint8Array,
): { body: Uint8Array; contentType: string } {
  const boundary = crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const head = enc.encode(
    `--${boundary}\r\nContent-Disposition: name="request_payload"\r\n` +
      `Content-Type: text/xml\r\n\r\n${payloadXml}\r\n` +
      `--${boundary}\r\nContent-Disposition: name="${partName}"; filename="${fileName}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const tail = enc.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(head.length + fileBytes.length + tail.length);
  body.set(head, 0);
  body.set(fileBytes, head.length);
  body.set(tail, head.length + fileBytes.length);
  return { body, contentType: `multipart/mixed; boundary=${boundary}` };
}

/**
 * Publishes a suite's data sources and its generated workbook with the tool's
 * Tableau session (PAT).
 */
export class ContentPublisher {
  private readonly _session: PublisherSession;
  private readonly _verify: boolean;
  private readonly _caBundlePath?: string;
  private readonly _fetch: FetchLike;
  private readonly _sleep: (ms: number) => Promise<void>;

  constructor(session: PublisherSession, opts: ContentPublisherOptions = {}) {
    this._session = session;
    this._verify = opts.verify ?? true;
    this._caBundlePath = opts.caBundlePath;
    this._fetch = opts.fetchImpl ?? fetch;
    this._sleep = opts.sleepImpl ?? ((ms) => Bun.sleep(ms));
  }

  private async _url(path: string, params: Record<string, string> = {}): Promise<string> {
    const siteId = await this._session.siteId();
    const qs = new URLSearchParams(params).toString();
    return `${this._session.serverUrl}/api/${API_VERSION}/sites/${siteId}${path}${qs ? `?${qs}` : ""}`;
  }

  private async _headers(extra: Record<string, string> = {}): Promise<Record<string, string>> {
    return { Accept: "application/json", ...(await this._session.authHeaders()), ...extra };
  }

  /**
   * One request; on a 5xx or a transport failure wait and send it again, up
   * to the retry schedule. The last 5xx is returned for `_check` to word; a
   * transport failure on the last try is raised as a ContentPublishError.
   */
  private async _do(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const attempts = PUBLISH_RETRY_DELAYS_MS.length + 1;
    for (let attempt = 0; ; attempt++) {
      let reason: string;
      try {
        const resp = await this._fetch(url, {
          ...init,
          signal: AbortSignal.timeout(timeoutMs),
          ...tlsInit({ verify: this._verify, caBundlePath: this._caBundlePath }),
        } as RequestInit);
        if (resp.status < 500 || attempt === attempts - 1) return resp;
        reason = `HTTP ${resp.status}`;
      } catch (exc) {
        if (attempt === attempts - 1) {
          const name = exc instanceof Error ? exc.name : String(exc);
          throw new ContentPublishError(
            `Tableau Server could not be reached to publish (${name}); tried ${attempts} times. ` +
              "Check the connection, then evaluate again.",
          );
        }
        reason = exc instanceof Error ? exc.name : String(exc);
      }
      const delay = PUBLISH_RETRY_DELAYS_MS[attempt]!;
      console.warn(`Publishing to Tableau Server failed (${reason}); trying again in ${delay / 1000}s`);
      await this._sleep(delay);
    }
  }

  private async _check(resp: Response, what: string): Promise<Json> {
    const text = await resp.text().catch(() => "");
    if (resp.status >= 400) {
      let detail = "";
      try {
        const err = ((JSON.parse(text) as Json).error || {}) as Json;
        detail = String(err.detail || err.summary || "");
      } catch {
        detail = text.slice(0, 200);
      }
      const tried =
        resp.status >= 500
          ? ` Tried ${PUBLISH_RETRY_DELAYS_MS.length + 1} times over a few minutes; the site's front door is dropping requests. Evaluate again later, or Resume.`
          : "";
      throw new ContentPublishError(
        `Tableau Server refused to ${what} (HTTP ${resp.status}). ${detail}`.trim() + tried,
      );
    }
    return text ? (JSON.parse(text) as Json) : {};
  }

  async findOrCreateProject(name: string): Promise<string> {
    let resp = await this._do(
      await this._url("/projects", { filter: `name:eq:${name}` }),
      { method: "GET", headers: await this._headers() },
      30_000,
    );
    const listed = await this._check(resp, "list projects");
    const projects = (((listed.projects || {}) as Json).project || []) as Array<{ id: string }>;
    if (projects.length) return projects[0]!.id;
    resp = await this._do(
      await this._url("/projects"),
      {
        method: "POST",
        headers: await this._headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          project: {
            name,
            description:
              "Sample dashboards and data sources the Tableau AI Model Evaluation Tool " +
              "asks questions about. Published by the tool; safe to delete when no " +
              "evaluation needs them.",
          },
        }),
      },
      30_000,
    );
    const created = await this._check(resp, "create the project");
    return ((created.project || {}) as Json).id as string;
  }

  /**
   * Publish a .tdsx, replacing a same-named data source in the project.
   * Returns the server's datasource record (id, contentUrl, ...).
   */
  async publishDatasource(path: string, name: string, projectId: string): Promise<Json> {
    const payload =
      `<tsRequest><datasource name=${quoteAttr(name)}>` +
      `<project id=${quoteAttr(projectId)}/></datasource></tsRequest>`;
    const { body, contentType } = multipartMixed(
      payload,
      "tableau_datasource",
      basename(path),
      contentReadBytes(path),
    );
    const resp = await this._do(
      await this._url("/datasources", {
        datasourceType: extname(path).replace(/^\./, ""),
        overwrite: "true",
      }),
      { method: "POST", headers: await this._headers({ "Content-Type": contentType }), body },
      600_000,
    );
    return (await this._check(resp, `publish the data source ${pyRepr(name)}`)).datasource as Json;
  }

  async publishWorkbook(xml: string, name: string, projectId: string): Promise<Json> {
    const payload =
      `<tsRequest><workbook name=${quoteAttr(name)} showTabs='true'>` +
      `<project id=${quoteAttr(projectId)}/></workbook></tsRequest>`;
    const { body, contentType } = multipartMixed(
      payload,
      "tableau_workbook",
      "sample.twb",
      new TextEncoder().encode(xml),
    );
    const resp = await this._do(
      await this._url("/workbooks", {
        workbookType: "twb",
        overwrite: "true",
        skipConnectionCheck: "true",
      }),
      { method: "POST", headers: await this._headers({ "Content-Type": contentType }), body },
      600_000,
    );
    return (await this._check(resp, `publish the workbook ${pyRepr(name)}`)).workbook as Json;
  }
}

/** Python-compatible `repr()` of a plain string for stable diagnostics. */
function pyRepr(s: string): string {
  return s.includes("'") && !s.includes('"') ? `"${s}"` : `'${s.replace(/'/g, "\\'")}'`;
}

export interface PublishOptions extends ContentPublisherOptions, ContentEnv {
  /** The session to publish with (the routes build it from the stored connection). */
  session: PublisherSession;
  store: SettingsStore;
}

/**
 * Publish everything the suite asks about and remember the ids.
 *
 * `connection` is the stored Tableau connection (server_url, site, ...).
 * Returns the remembered record.
 */
export async function publishSuiteContent(
  suiteId: string,
  connection: Json,
  opts: PublishOptions,
): Promise<PublishedContent> {
  const content = suiteContent(suiteId, opts);
  if (content === null) {
    throw new ContentPublishError(`No sample content is defined for the suite ${pyRepr(suiteId)}.`);
  }
  const missing = content.datasources.filter((d) => !d.present).map((d) => d.file);
  if (missing.length) {
    throw new ContentPublishError(
      "These sample files are missing from the tool's public-suites/dashboard-qa/content " +
        `folder: ${missing.join(", ")}.`,
    );
  }
  const server = String(connection.server_url || connection.tableau_server || "").replace(
    /\/+$/,
    "",
  );
  const site = String(connection.site || connection.tableau_site || "");
  const publisher = new ContentPublisher(opts.session, opts);
  const projectId = await publisher.findOrCreateProject(content.project);

  const published: PublishedDatasource[] = [];
  for (const ds of content.datasources) {
    const record = await publisher.publishDatasource(ds.path!, ds.name, projectId);
    published.push({
      luid: record.id as string,
      name: ds.name,
      content_url: (record.contentUrl as string) || "",
      display_name: ds.display_name ?? null,
      luid_key: ds.luid_key ?? null,
      file: ds.file,
    });
  }

  const wb = content.workbook;
  const xml = buildWorkbookXml(
    server,
    site,
    wb.dashboard,
    published.map((p, i) => {
      const ds = content.datasources[i]!;
      return {
        caption: p.display_name || p.name,
        content_url: p.content_url,
        sheet: ds.sheet,
        measure_type: ds.sheet.measure_type ?? null,
      };
    }),
  );
  const wbRecord = await publisher.publishWorkbook(xml, wb.name, projectId);

  const ids: PublishedContent = {
    workbook_luid: wbRecord.id as string,
    workbook_name: wb.name,
    workbook_content_url: (wbRecord.contentUrl as string) || "",
    dashboard: wb.dashboard,
    project: content.project,
    datasources: published,
    published_at: new Date().toISOString().replace("Z", "+00:00"),
  };
  rememberContent(opts.store, server, site, suiteId, ids as unknown as Json);
  return ids;
}

/**
 * For every suite with sample content: whether its files are present, what
 * would be published, and the ids remembered for this site.
 */
export function contentStatus(
  store: SettingsStore,
  server: string,
  site: string,
  env: ContentEnv = {},
): Record<string, Json> {
  const out: Record<string, Json> = {};
  const remembered = storedContentForSite(store, server, site);
  for (const suiteId of Object.keys(loadManifest(env).suites || {})) {
    const content = suiteContent(suiteId, env);
    if (content === null) continue;
    const ids = (Object.hasOwn(remembered, suiteId) ? remembered[suiteId] : null) || {};
    const current = rememberedContentIsCurrent(suiteId, ids, env);
    out[suiteId] = {
      project: content.project,
      workbook: content.workbook.name,
      dashboard: content.workbook.dashboard,
      datasources: content.datasources.map((d) => d.name),
      files_present: content.datasources.every((d) => d.present),
      // Published, and still the content this suite asks about: a suite whose
      // sample content changed is published again by the next run.
      published: Boolean(ids.workbook_luid) && current,
      stale: Boolean(ids.workbook_luid) && !current,
      ids,
    };
  }
  return out;
}
