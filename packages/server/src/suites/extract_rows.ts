/**
 * The first rows of a Tableau extract that ships with the tool, read from a
 * `.tdsx` (a ZIP holding a `.tds` and a `.hyper`). The results page shows
 * them beside a Questions about a dashboard answer so the answer can be
 * checked against the data it was computed from (bug bash 2026-10-23).
 *
 * The `.hyper` is unpacked once into the temp directory (Hyper opens files,
 * not bytes) and read with the same Hyper engine the publish path uses.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { contentReadBytes } from "@tableau-ai-eval/core";
import { getHyperdPath, loadHyper } from "../hyper/loader.ts";

export interface ExtractRows {
  /** The table read, as schema.table. */
  table: string;
  columns: Array<{ name: string; type: string }>;
  /** Every cell as text (NULL stays null), so dates and numbers need no type mapping. */
  rows: Array<Array<string | null>>;
  /** Rows in the table, for "showing 50 of 17,000". */
  total: number;
  limit: number;
}

/** The entries of a ZIP file: name -> bytes. Enough of the format for a .tdsx (no ZIP64, no encryption). */
export function unzipEntries(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, Uint8Array>();
  // End of central directory: scan back from the end (a comment may follow it).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP file: no central directory");
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const text = new TextDecoder();
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error("not a ZIP file: bad central directory entry");
    const method = view.getUint16(p + 10, true);
    const compressed = view.getUint32(p + 20, true);
    const uncompressed = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = text.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`not a ZIP file: bad local header for ${name}`);
    const dataStart = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(dataStart, dataStart + compressed);
    if (method === 0) out.set(name, data);
    else if (method === 8) {
      const inflated = inflateRawSync(data);
      if (inflated.length !== uncompressed) throw new Error(`ZIP entry ${name} did not inflate to its stated size`);
      out.set(name, new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength));
    } else throw new Error(`ZIP entry ${name} uses compression method ${method}, which the tool does not read`);
  }
  return out;
}

/** The `.hyper` inside a `.tdsx`, unpacked to a file the Hyper engine can open; cached by content. */
export function unpackedHyperPath(tdsxPath: string): string {
  const bytes = contentReadBytes(tdsxPath);
  const entries = unzipEntries(bytes);
  const hyperName = [...entries.keys()].find((n) => n.toLowerCase().endsWith(".hyper"));
  if (!hyperName) throw new Error(`${tdsxPath} holds no .hyper extract`);
  const hyper = entries.get(hyperName)!;
  const dir = join(tmpdir(), "tableau-ai-eval", "extracts");
  mkdirSync(dir, { recursive: true });
  const digest = createHash("sha1").update(hyper).digest("hex").slice(0, 16);
  const path = join(dir, `${digest}.hyper`);
  if (!existsSync(path)) writeFileSync(path, hyper);
  return path;
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Read the first `limit` rows of the extract's (first) table, every cell as text. */
export async function readExtractRows(tdsxPath: string, limit = 50): Promise<ExtractRows> {
  const hyperPath = unpackedHyperPath(tdsxPath);
  const { HyperProcess, Connection, CreateMode, Catalog } = await loadHyper();
  const hyperdPath = getHyperdPath();
  if (!hyperdPath) throw new Error("the Hyper engine is not installed on this computer yet");
  const hyper = new HyperProcess(hyperdPath);
  try {
    const conn = await Connection.connect(hyper.endpoint, hyperPath, CreateMode.DoNotCreate);
    try {
      const catalog = new Catalog(conn);
      // A Tableau extract keeps its data in "Extract"."Extract"; any other
      // single table is read the same way.
      const schemas = (await catalog.getSchemaNames()).filter((s) => s !== "public" || true);
      let found: { schema: string; table: string } | null = null;
      for (const schema of [...schemas].sort((a, b) => (a === "Extract" ? -1 : b === "Extract" ? 1 : 0))) {
        const tables = await catalog.getTableNames(schema);
        if (tables.length) { found = { schema, table: tables[0]! }; break; }
      }
      if (!found) throw new Error("the extract holds no table");
      const table = `${quoteIdent(found.schema)}.${quoteIdent(found.table)}`;
      const columns = await conn.querySchema(`SELECT * FROM ${table} LIMIT 0`);
      const select = columns.map((c) => `CAST(${quoteIdent(c.name)} AS TEXT) AS ${quoteIdent(c.name)}`).join(", ");
      const rows = await conn.executeQuery(`SELECT ${select} FROM ${table} LIMIT ${Math.floor(limit)}`);
      const counted = await conn.executeQuery(`SELECT COUNT(*) FROM ${table}`);
      const total = counted.length ? Number(counted[0]!.getInt64(0) ?? 0) : 0;
      return {
        table: `${found.schema}.${found.table}`,
        columns: columns.map((c) => ({ name: c.name, type: c.typeName })),
        rows: rows.map((r) => columns.map((_c, i) => (r.isNull(i) ? null : r.getString(i)))),
        total,
        limit,
      };
    } finally {
      await conn.close();
    }
  } finally {
    hyper.close();
  }
}
