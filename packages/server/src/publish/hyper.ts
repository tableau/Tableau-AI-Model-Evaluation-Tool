/**
 * Hyper publish-back.
 *
 * Two independent pieces:
 *   1. `buildHyper(export, hyperPath)` — writes the single long-form `.hyper`
 *      for one run using the lazy Hyper loader (`src/hyper/loader.ts`). Same
 *      append-stable schema (one row per test case × metric, NULL-safe so a
 *      metric-less case still gets one row with NULL metric fields).
 *   2. `TableauPublisher` + `publishRun` — the Tableau REST create/append flow,
 *      built on `TableauSession` for X-Tableau-Auth, with an injectable `fetch`.
 *
 * QUIRK CARRIED FROM PHASE 1: `RowInserter.addRow` REJECTS a
 * JS `BigInt` for a `bigInt` column, so int columns get a plain JS `number`
 * (all small; well under 2^53). Reads come back as `bigint`.
 *
 * SCHEMA: `records.ts` RUN_COLUMNS (35) +
 * CASE_COLUMNS (15) + METRIC_COLUMNS (10) = 60 columns; `timestamp` columns
 * are TIMESTAMP_TZ, `json` columns compact JSON text (Python
 * `json.dumps(x, separators=(",", ":"))`, reproduced by `records.pyJson`).
 * The datasource is tagged `SCHEMA_TAG` when created; publishing into a
 * same-name datasource without that tag raises `SchemaMismatch`.
 */

import { loadHyper, loadedHyper, getHyperdPath } from "../hyper/loader.ts";
// Type-only import: the installed declarations are not included in the release.
import type { TableDefinition as TableDefinitionType } from "hyperdb-api-node";
import type { Export } from "./export.ts";
import {
  CASE_COLUMNS,
  METRIC_COLUMNS,
  RUN_COLUMNS,
  SCHEMA_VERSION,
  parseTimestamp,
  pyJson,
  type Column,
  type ColumnType,
} from "./records.ts";
import type { TableauSession } from "@tableau-ai-eval/core";
import type { FetchLike } from "@tableau-ai-eval/core";
import { tlsInit } from "@tableau-ai-eval/core";

export const API_VERSION = "3.22";
export const DEFAULT_PROJECT = "AI Model Evaluations";
export const DEFAULT_DATASOURCE = "AI Model Evaluation Results";

// Single-request publishes cap at 64 MB; larger files go through the
// file-upload session in <=64 MB chunks. Stay under the cap with margin.
export const SINGLE_REQUEST_LIMIT = 60 * 1024 * 1024;
export const CHUNK_BYTES = 60 * 1024 * 1024;

/**
 * The datasource's tag for the current column set. Bump with
 * `SCHEMA_VERSION`: a datasource carrying an older tag (or none, for
 * datasources made before schema 2) must not receive appends.
 */
export const SCHEMA_TAG = `ai-model-eval-schema-${SCHEMA_VERSION}`;

export const JUDGE_STAGE = "llmJudge";

export interface HyperRowCounts {
  results: number;
  metrics: number;
}

/** The datasource on the server predates this version's column set. */
export class SchemaMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaMismatch";
  }
}

/** Every column of the long-form table, in order (run, case, metric). */
export const RESULTS_COLUMNS: readonly Column[] = [
  ...RUN_COLUMNS,
  ...CASE_COLUMNS,
  ...METRIC_COLUMNS,
];

function sqlTypeFor(type: ColumnType) {
  const { SqlType } = loadedHyper();
  switch (type) {
    case "int":
      return SqlType.bigInt();
    case "double":
      return SqlType.double();
    case "bool":
      return SqlType.bool();
    case "timestamp":
      return SqlType.timestampTz();
    default:
      return SqlType.text(); // text + json
  }
}

/**
 * The long-form results TableDefinition (names + types from `records.ts`).
 * Exported so tests can assert the schema independently; await loadHyper() first.
 */
export function resultsTableDefinition(name = "results"): TableDefinitionType {
  const { TableDefinition } = loadedHyper();
  const def = new TableDefinition(name).withSchema("public");
  for (const [col, type] of RESULTS_COLUMNS) def.addColumn(col, sqlTypeFor(type), true);
  return def;
}

/**
 * The same columns with every TIMESTAMP_TZ staged as TEXT. The addon's
 * RowInserter mis-encodes JS values for a TIMESTAMP_TZ column (a string or
 * Date reads back tens of millennia off; verified against hyperdb-api-node
 * 0.7.3), so timestamps are inserted as `…+00:00` text into this staging
 * table and CAST server-side into `results` (see `buildHyper`).
 */
function stagingTableDefinition(): TableDefinitionType {
  const { TableDefinition, SqlType } = loadedHyper();
  const def = new TableDefinition(STAGING_TABLE).withSchema("public");
  for (const [col, type] of RESULTS_COLUMNS)
    def.addColumn(col, type === "timestamp" ? SqlType.text() : sqlTypeFor(type), true);
  return def;
}

const STAGING_TABLE = "_results_stage";

type HyperCell = string | number | boolean | null;

/** A column value for the Hyper inserter. */
function hyperValue(value: unknown, type: ColumnType): HyperCell {
  if (value === null || value === undefined) return null;
  switch (type) {
    case "json":
      return pyJson(value);
    case "timestamp": {
      // Hyper ignores a trailing "Z" (reads the time as the server's local
      // zone), so pass an explicit +00:00 offset.
      const d = parseTimestamp(value);
      return d ? d.toISOString().replace(/Z$/, "+00:00") : null;
    }
    case "double":
      return Number(value);
    case "int":
      // bigInt column — pass a plain number (Phase-1 quirk), NOT a BigInt.
      return Math.trunc(Number(value));
    case "bool":
      return Boolean(value);
    default:
      return String(value);
  }
}

const quoteIdent = (n: string) => `"${n.replace(/"/g, '""')}"`;

/**
 * Write the single long-form `.hyper` for one run; returns row counts.
 *
 * One row per test
 * case × metric; a case with no metrics still gets one row with NULL metric
 * fields so no case ever drops out of the datasource. Columns and their order
 * come from `records.ts` (the CSV carries the same run and case columns), and
 * timestamps are real TIMESTAMP_TZ values so Tableau treats them as dates.
 * The file holds exactly ONE table (`public.results`) — the server rejects a
 * multi-table .hyper on initial publish — so the timestamp staging table is
 * dropped before the file is closed.
 *
 * @param exp        the export from `buildExportFromData`
 * @param hyperPath  destination `.hyper` file path
 * @param hyperdPath optional override for the `hyperd` binary (test seam)
 */
export async function buildHyper(
  exp: Export,
  hyperPath: string,
  hyperdPath?: string | null,
): Promise<HyperRowCounts> {
  const { HyperProcess, Connection, CreateMode, Catalog, RowInserter } = await loadHyper();
  const resultsDef = resultsTableDefinition();
  const stageDef = stagingTableDefinition();
  const run = exp.run;
  const runValues = RUN_COLUMNS.map(([n, t]) => hyperValue(run[n], t));
  const nMetricCols = METRIC_COLUMNS.length;

  let nResults = 0;
  let nMetrics = 0;

  const hyper = new HyperProcess(hyperdPath ?? getHyperdPath());
  try {
    const conn = await Connection.connect(
      hyper.endpoint,
      hyperPath,
      CreateMode.CreateAndReplace,
    );
    try {
      const catalog = new Catalog(conn);
      await catalog.createTable(resultsDef);
      await catalog.createTable(stageDef);

      const ins = new RowInserter(conn, stageDef);
      for (const c of exp.cases) {
        const caseValues: HyperCell[] = [
          ...runValues,
          ...CASE_COLUMNS.map(([n, t]) => hyperValue(c[n], t)),
        ];
        nResults += 1;
        const metrics = c.metrics || [];
        if (metrics.length === 0) {
          // Metric-less case: keep it visible with NULL metric fields.
          ins.addRow([...caseValues, ...new Array<null>(nMetricCols).fill(null)]);
          continue;
        }
        for (const m of metrics) {
          const rec = m as unknown as Record<string, unknown>;
          ins.addRow([...caseValues, ...METRIC_COLUMNS.map(([n, t]) => hyperValue(rec[n], t))]);
          nMetrics += 1;
        }
      }
      await ins.execute();

      const select = RESULTS_COLUMNS.map(([n, t]) =>
        t === "timestamp"
          ? `CAST(${quoteIdent(n)} AS TIMESTAMP WITH TIME ZONE)`
          : quoteIdent(n),
      ).join(", ");
      await conn.executeCommand(
        `INSERT INTO "public"."results" SELECT ${select} FROM "public".${quoteIdent(STAGING_TABLE)}`,
      );
      await conn.executeCommand(`DROP TABLE "public".${quoteIdent(STAGING_TABLE)}`);
    } finally {
      await conn.close();
    }
  } finally {
    hyper.close();
  }

  return { results: nResults, metrics: nMetrics };
}

// ---------------------------------------------------------------------------
// Tableau REST publish flow.
// ---------------------------------------------------------------------------

/** XML attribute escaping — mirrors xml.sax.saxutils.quoteattr. */
function quoteAttr(value: string): string {
  let s = value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (s.includes('"')) {
    s = s.replace(/"/g, "&quot;");
    return `"${s}"`;
  }
  return `"${s}"`;
}

type FilePart = { partName: string; fileName: string; bytes: Uint8Array };

/**
 * Assemble a multipart/mixed body per the REST publishing guide. Hand-rolled
 * because these endpoints reject multipart/form-data. The `request_payload`
 * part is ALWAYS present (chunk appends need it "effectively blank"); its
 * Content-Type is `text/xml` (JSON is rejected in the parts); file bytes go
 * raw. Returns the body bytes and the Content-Type header value.
 */
function multipartMixed(
  payloadXml: string,
  filePart: FilePart | null = null,
): { body: Uint8Array; contentType: string } {
  const boundary = crypto.randomUUID().replace(/-/g, "");
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];

  chunks.push(
    enc.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: name="request_payload"\r\n` +
        `Content-Type: text/xml\r\n\r\n` +
        `${payloadXml}\r\n`,
    ),
  );

  if (filePart !== null) {
    chunks.push(
      enc.encode(
        `--${boundary}\r\n` +
          `Content-Disposition: name="${filePart.partName}"; filename="${filePart.fileName}"\r\n` +
          `Content-Type: application/octet-stream\r\n\r\n`,
      ),
    );
    chunks.push(filePart.bytes);
    chunks.push(enc.encode("\r\n"));
  }

  chunks.push(enc.encode(`--${boundary}--\r\n`));

  // Concatenate.
  let total = 0;
  for (const c of chunks) total += c.length;
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    body.set(c, off);
    off += c.length;
  }
  return { body, contentType: `multipart/mixed; boundary=${boundary}` };
}

function datasourceTsRequest(name: string, projectId: string): string {
  return (
    `<tsRequest><datasource name=${quoteAttr(name)}>` +
    `<project id=${quoteAttr(projectId)}/></datasource></tsRequest>`
  );
}

/** A minimal reader for the `.hyper` file so this stays runtime-agnostic. */
export interface FileReader {
  readBytes(path: string): Promise<Uint8Array>;
  size(path: string): Promise<number>;
}

/** Default FileReader backed by Bun.file. */
export const bunFileReader: FileReader = {
  async readBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await Bun.file(path).arrayBuffer());
  },
  async size(path: string): Promise<number> {
    return Bun.file(path).size;
  },
};

async function raiseForStatus(resp: Response): Promise<void> {
  if (resp.status >= 400) {
    let text = "";
    try {
      text = await resp.text();
    } catch {
      /* ignore */
    }
    const err = new HttpError(
      `HTTP ${resp.status} for ${resp.url}: ${text.slice(0, 200)}`,
      resp.status,
    );
    throw err;
  }
}

/** REST error carrying the HTTP status (analogue of requests.HTTPError). */
export class HttpError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export interface TableauPublisherOptions {
  verify?: boolean;
  /**
   * PEM CA bundle path to trust when `verify` is true (private/enterprise CA).
   * Mirrors the TableauSession TLS ergonomics: without this, a private CA is
   * rejected even though sign-in (which does get the bundle) succeeds.
   */
  caBundlePath?: string;
  fetchImpl?: FetchLike;
  fileReader?: FileReader;
}

/** A datasource as `GET …/datasources` lists it. */
export interface DatasourceEntry {
  id: string;
  project?: { id?: string };
  tags?: { tag?: Array<{ label?: string }> };
  [key: string]: unknown;
}

/** Thin REST client for project/datasource management + append. */
export class TableauPublisher {
  private readonly _session: TableauSession;
  private readonly _verify: boolean;
  private readonly _caBundlePath?: string;
  private readonly _fetch: FetchLike;
  private readonly _files: FileReader;

  constructor(session: TableauSession, opts: TableauPublisherOptions = {}) {
    this._session = session;
    this._verify = opts.verify ?? true;
    this._caBundlePath = opts.caBundlePath;
    this._fetch = opts.fetchImpl ?? fetch;
    this._files = opts.fileReader ?? bunFileReader;
  }

  private async _url(path: string): Promise<string> {
    const siteId = await this._session.siteId();
    return (
      `${this._session.serverUrl}/api/${API_VERSION}` +
      `/sites/${siteId}${path}`
    );
  }

  private async _headers(
    extra: Record<string, string> = {},
  ): Promise<Record<string, string>> {
    const h: Record<string, string> = { Accept: "application/json" };
    Object.assign(h, await this._session.authHeaders());
    Object.assign(h, extra);
    return h;
  }

  private async _do(
    url: string,
    init: RequestInit & { tls?: unknown },
  ): Promise<Response> {
    // Same TLS ergonomics as TableauSession: verify=false disables the chain;
    // verify=true + caBundlePath trusts a private CA; otherwise system trust.
    // Every publisher REST call goes through here, so the CA bundle applies to
    // findOrCreateProject / uploadFile / publishNew / append alike.
    const tls = tlsInit({ verify: this._verify, caBundlePath: this._caBundlePath });
    return this._fetch(url, { ...init, ...tls });
  }

  async findOrCreateProject(name: string): Promise<string> {
    const listUrl =
      (await this._url("/projects")) +
      `?filter=${encodeURIComponent(`name:eq:${name}`)}`;
    let resp = await this._do(listUrl, {
      method: "GET",
      headers: await this._headers(),
      signal: AbortSignal.timeout(30_000),
    });
    await raiseForStatus(resp);
    const listBody = (await resp.json()) as {
      projects?: { project?: Array<{ id: string }> };
    };
    const projects = listBody.projects?.project ?? [];
    if (projects.length > 0) return projects[0].id;

    resp = await this._do(await this._url("/projects"), {
      method: "POST",
      headers: await this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        project: {
          name,
          description:
            "Tableau AI model evaluation results. Each run appends rows " +
            "tagged by run_id. Restricted to site admins by default.",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });
    await raiseForStatus(resp);
    const createBody = (await resp.json()) as { project: { id: string } };
    return createBody.project.id;
  }

  /**
   * The datasource of that name in that project, as the server lists it
   * (id, tags, …), or null.
   */
  async findDatasourceEntry(
    name: string,
    projectId: string,
  ): Promise<DatasourceEntry | null> {
    const url =
      (await this._url("/datasources")) +
      `?filter=${encodeURIComponent(`name:eq:${name}`)}`;
    const resp = await this._do(url, {
      method: "GET",
      headers: await this._headers(),
      signal: AbortSignal.timeout(30_000),
    });
    await raiseForStatus(resp);
    const body = (await resp.json()) as {
      datasources?: { datasource?: DatasourceEntry[] };
    };
    for (const ds of body.datasources?.datasource ?? []) {
      if (ds.project?.id === projectId) return ds;
    }
    return null;
  }

  async findDatasource(
    name: string,
    projectId: string,
  ): Promise<string | null> {
    const entry = await this.findDatasourceEntry(name, projectId);
    return entry ? entry.id : null;
  }

  /** The tag labels on a listed datasource. */
  static datasourceTags(entry: DatasourceEntry | null | undefined): Set<string> {
    const tags = entry?.tags?.tag ?? [];
    const out = new Set<string>();
    for (const t of tags) if (t && typeof t === "object" && t.label) out.add(t.label);
    return out;
  }

  /** Tag the datasource (PUT …/datasources/{id}/tags). */
  async addTags(datasourceId: string, labels: string[]): Promise<void> {
    const resp = await this._do(await this._url(`/datasources/${datasourceId}/tags`), {
      method: "PUT",
      headers: await this._headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ tags: { tag: labels.map((label) => ({ label })) } }),
      signal: AbortSignal.timeout(30_000),
    });
    await raiseForStatus(resp);
  }

  /** Upload a file through a file-upload session in <=64MB chunks. */
  async uploadFile(hyperPath: string): Promise<string> {
    let resp = await this._do(await this._url("/fileUploads"), {
      method: "POST",
      headers: await this._headers(),
      signal: AbortSignal.timeout(30_000),
    });
    await raiseForStatus(resp);
    const startBody = (await resp.json()) as {
      fileUpload: { uploadSessionId: string };
    };
    const uploadId = startBody.fileUpload.uploadSessionId;

    const fileName = hyperPath.split("/").pop() || "results.hyper";
    const bytes = await this._files.readBytes(hyperPath);
    let seq = 0;
    for (let offset = 0; offset < bytes.length || seq === 0; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
      if (chunk.length === 0 && bytes.length > 0) break;
      seq += 1;
      // Blank request_payload part is REQUIRED on chunk appends.
      const { body, contentType } = multipartMixed("", {
        partName: "tableau_file",
        fileName,
        bytes: chunk,
      });
      resp = await this._do(
        (await this._url(`/fileUploads/${uploadId}`)) + `?sequenceID=${seq}`,
        {
          method: "PUT",
          headers: await this._headers({ "Content-Type": contentType }),
          body,
          signal: AbortSignal.timeout(300_000),
        },
      );
      await raiseForStatus(resp);
      if (chunk.length < CHUNK_BYTES) break;
    }
    return uploadId;
  }

  /** Create the datasource: single-request under 64MB, else chunked upload. */
  async publishNew(
    hyperPath: string,
    name: string,
    projectId: string,
  ): Promise<string> {
    const payloadXml = datasourceTsRequest(name, projectId);
    const size = await this._files.size(hyperPath);

    let resp: Response;
    if (size <= SINGLE_REQUEST_LIMIT) {
      const { body, contentType } = multipartMixed(payloadXml, {
        partName: "tableau_datasource",
        fileName: "results.hyper",
        bytes: await this._files.readBytes(hyperPath),
      });
      resp = await this._do(
        (await this._url("/datasources")) +
          `?datasourceType=hyper&overwrite=false`,
        {
          method: "POST",
          headers: await this._headers({ "Content-Type": contentType }),
          body,
          signal: AbortSignal.timeout(300_000),
        },
      );
    } else {
      const uploadId = await this.uploadFile(hyperPath);
      const { body, contentType } = multipartMixed(payloadXml);
      resp = await this._do(
        (await this._url("/datasources")) +
          `?uploadSessionId=${uploadId}&datasourceType=hyper&overwrite=false`,
        {
          method: "POST",
          headers: await this._headers({ "Content-Type": contentType }),
          body,
          signal: AbortSignal.timeout(300_000),
        },
      );
    }
    await raiseForStatus(resp);
    const body = (await resp.json()) as { datasource: { id: string } };
    return body.datasource.id;
  }

  /** Append via Update Data Source Data: file-upload session → PATCH …/data. */
  async append(
    hyperPath: string,
    datasourceId: string,
  ): Promise<Record<string, unknown>> {
    const uploadId = await this.uploadFile(hyperPath);
    const resp = await this._do(
      (await this._url(`/datasources/${datasourceId}/data`)) +
        `?uploadSessionId=${uploadId}`,
      {
        method: "PATCH",
        headers: await this._headers({
          "Content-Type": "application/json",
          // Required idempotency key: a retried PATCH must not double-append.
          RequestID: crypto.randomUUID().replace(/-/g, ""),
        }),
        body: JSON.stringify({
          actions: [
            {
              action: "insert",
              "source-table": "results",
              "target-table": "results",
            },
          ],
        }),
        signal: AbortSignal.timeout(60_000),
      },
    );
    await raiseForStatus(resp);
    const body = (await resp.json()) as { job?: Record<string, unknown> };
    return body.job ?? {};
  }
}

export interface PublishRunResult {
  action: "created" | "appended";
  project_id: string;
  datasource_id: string;
  datasource: string;
  project: string;
  schema_version: number;
  run_id: string;
  rows: HyperRowCounts;
  append_job_id: unknown;
}

export interface PublishRunOptions {
  session: TableauSession;
  projectName?: string;
  datasourceName?: string;
  verify?: boolean;
  /** PEM CA bundle path to trust when verify is true (private/enterprise CA). */
  caBundlePath?: string;
  fetchImpl?: FetchLike;
  fileReader?: FileReader;
  /** Where to write the temp .hyper (defaults to a temp file). */
  hyperPath?: string;
  hyperdPath?: string | null;
  /** Sleep between eventual-consistency re-finds (ms); default 2000. */
  sleepMs?: number;
  /** Test seam: replace the .hyper build (REST-flow tests without hyperd). */
  buildHyperImpl?: typeof buildHyper;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Refuse a datasource made by an earlier schema. */
function checkSchemaTag(
  entry: DatasourceEntry,
  datasourceName: string,
  projectName: string,
): void {
  if (TableauPublisher.datasourceTags(entry).has(SCHEMA_TAG)) return;
  throw new SchemaMismatch(
    `The datasource "${datasourceName}" in project "${projectName}" was ` +
      "created by an earlier version of this tool, with a different set of " +
      "columns, so this run cannot be added to it. Rename or delete that " +
      "datasource on the server, then publish again: the next publish " +
      `creates a new "${datasourceName}" (tagged ${SCHEMA_TAG}) that later ` +
      "runs are added to.",
  );
}

/**
 * Publish one run: build the `.hyper`, create-or-append server-side.
 *
 * Takes an already-built
 * export. Throws
 * TableauAuthError on a refused PAT, SchemaMismatch when the datasource on the
 * server predates this column set, and HttpError on REST failures — the route
 * maps those to 401/409/502.
 */
export async function publishRun(
  exp: Export,
  opts: PublishRunOptions,
): Promise<PublishRunResult> {
  const jobId = String(exp.run.run_id);
  const projectName = opts.projectName ?? DEFAULT_PROJECT;
  const datasourceName = opts.datasourceName ?? DEFAULT_DATASOURCE;
  const publisher = new TableauPublisher(opts.session, {
    verify: opts.verify,
    caBundlePath: opts.caBundlePath,
    fetchImpl: opts.fetchImpl,
    fileReader: opts.fileReader,
  });

  const hyperPath =
    opts.hyperPath ??
    `${require("node:os").tmpdir()}/tableau-ai-eval-hyper-${jobId}-${process.pid}.hyper`;

  const counts = await (opts.buildHyperImpl ?? buildHyper)(
    exp,
    hyperPath,
    opts.hyperdPath,
  );

  const projectId = await publisher.findOrCreateProject(projectName);
  let entry = await publisher.findDatasourceEntry(datasourceName, projectId);
  if (entry !== null) checkSchemaTag(entry, datasourceName, projectName);
  let dsId: string | null = entry ? entry.id : null;
  let action: "created" | "appended";
  let job: Record<string, unknown> = {};

  if (dsId === null) {
    try {
      dsId = await publisher.publishNew(hyperPath, datasourceName, projectId);
      await publisher.addTags(dsId, [SCHEMA_TAG]);
      action = "created";
    } catch (exc) {
      // The name filter behind findDatasource is eventually consistent: a
      // create can race into a duplicate-name rejection (403/409 seen live).
      // Re-find with patience and append.
      const status = exc instanceof HttpError ? exc.status : 0;
      if (status !== 403 && status !== 409) throw exc;
      entry = null;
      for (let i = 0; i < 5; i++) {
        await sleep(opts.sleepMs ?? 2000);
        entry = await publisher.findDatasourceEntry(datasourceName, projectId);
        if (entry !== null) break;
      }
      if (entry === null) throw exc;
      checkSchemaTag(entry, datasourceName, projectName);
      dsId = entry.id;
      job = await publisher.append(hyperPath, dsId);
      action = "appended";
    }
  } else {
    job = await publisher.append(hyperPath, dsId);
    action = "appended";
  }

  return {
    action,
    project_id: projectId,
    datasource_id: dsId,
    datasource: datasourceName,
    project: projectName,
    schema_version: SCHEMA_VERSION,
    run_id: jobId,
    rows: counts,
    append_job_id: job.id,
  };
}
