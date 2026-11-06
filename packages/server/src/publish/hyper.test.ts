/**
 * Hyper publish parity (schema 3): `buildHyper`
 * writes the same table the reference publisher wrote
 * for the same inputs (`goldens/publish/run_inputs.json` →
 * `expected_hyper_rows.json`, retained reference outputs): same single
 * table, same columns + types, same rows (timestamps as real TIMESTAMP_TZ).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FullResults, JobState } from "@tableau-ai-eval/core";
import type { Connection as ConnectionType } from "hyperdb-api-node";
import { loadHyper, getHyperdPath } from "../hyper/loader.ts";
import { buildExportFromData } from "./export.ts";
import { RESULTS_COLUMNS, SCHEMA_TAG, buildHyper, resultsTableDefinition } from "./hyper.ts";

const { Catalog, Connection, CreateMode, HyperProcess } = await loadHyper();

const GOLDEN_DIR = join(import.meta.dir, "..", "..", "..", "..", "goldens", "publish");
const INPUTS = JSON.parse(readFileSync(join(GOLDEN_DIR, "run_inputs.json"), "utf-8")) as {
  fixed_now: string;
  runs: Record<string, { data: FullResults; state: JobState }>;
};
const GOLDEN = JSON.parse(readFileSync(join(GOLDEN_DIR, "expected_hyper_rows.json"), "utf-8")) as {
  schema_tag: string;
  runs: Record<
    string,
    {
      counts: { results: number; metrics: number };
      tables: string[];
      columns: Array<{ name: string; type: string }>;
      rows: unknown[][];
    }
  >;
};

const paths: string[] = [];
afterAll(() => {
  for (const p of paths) rmSync(p, { force: true });
});

type Kind = "bigint" | "double" | "bool" | "timestamp" | "text";
/** Addon SQL type names and Python `str(c.type)` → one canonical kind. */
function typeKind(typeName: string): Kind {
  const t = typeName.toUpperCase();
  if (t === "BIGINT" || t === "BIG_INT") return "bigint";
  if (t === "DOUBLE PRECISION" || t === "DOUBLE") return "double";
  if (t === "BOOLEAN" || t === "BOOL") return "bool";
  if (t.startsWith("TIMESTAMP")) return "timestamp";
  return "text";
}

function readRows(rows: Awaited<ReturnType<ConnectionType["executeQuery"]>>): unknown[][] {
  const cols = resultsTableDefinition().getColumns();
  return rows.map((row) =>
    cols.map((c, i) => {
      if (row.isNull(i)) return null;
      switch (typeKind(c.typeName)) {
        case "bigint":
          return Number(row.getBigInt(i));
        case "double":
          return row.getFloat64(i);
        case "bool":
          return row.getBool(i);
        case "timestamp":
          return new Date(row.getTimestampMs(i)!).toISOString().replace(/\.\d{3}Z$/, "Z");
        default:
          return row.getString(i);
      }
    }),
  );
}

async function buildAndRead(job: string) {
  const { data, state } = INPUTS.runs[job];
  const exp = buildExportFromData(job, structuredClone(data), state, () => new Date(INPUTS.fixed_now));
  const path = join(tmpdir(), `tableau-ai-eval-hyper-${job.slice(0, 8)}-${process.pid}.hyper`);
  paths.push(path);
  const counts = await buildHyper(exp, path, getHyperdPath());
  const hyper = new HyperProcess(getHyperdPath());
  try {
    const conn = await Connection.connect(hyper.endpoint, path, CreateMode.DoNotCreate);
    try {
      const tables = await new Catalog(conn).getTableNames("public");
      const colList = RESULTS_COLUMNS.map(([n]) => `"${n}"`).join(", ");
      const rows = await conn.executeQuery(
        `SELECT ${colList} FROM "public"."results" ` +
          `ORDER BY "case_number", "metric_stage" NULLS LAST, "metric_name" NULLS LAST`,
      );
      return { counts, tables, rows: readRows(rows) };
    } finally {
      await conn.close();
    }
  } finally {
    hyper.close();
  }
}

test("schema tag matches the Python SCHEMA_TAG", () => {
  expect(SCHEMA_TAG).toBe(GOLDEN.schema_tag);
});

describe("parity with the publish goldens (goldens/publish)", () => {
  for (const [job, want] of Object.entries(GOLDEN.runs)) {
    test(`${job.slice(0, 8)}: one table, same columns/types, same rows`, async () => {
      const cols = resultsTableDefinition().getColumns();
      expect(cols.map((c) => c.name)).toEqual(want.columns.map((c) => c.name));
      expect(cols.map((c) => typeKind(c.typeName))).toEqual(want.columns.map((c) => typeKind(c.type)));

      const got = await buildAndRead(job);
      expect(got.counts).toEqual(want.counts);
      // The server rejects a multi-table .hyper: the staging table is gone.
      expect(got.tables.map((t: unknown) => String(t).replace(/^.*\./, "").replace(/"/g, ""))).toEqual(
        want.tables,
      );
      expect(got.rows.length).toBe(want.rows.length);
      got.rows.forEach((row, r) =>
        row.forEach((a, c) => {
          const b = want.rows[r][c];
          if (typeof a === "number" && typeof b === "number") expect(a).toBeCloseTo(b, 9);
          else expect([cols[c].name, a]).toEqual([cols[c].name, b]);
        }),
      );
    });
  }
});
