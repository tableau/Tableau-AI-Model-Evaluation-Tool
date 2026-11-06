import { test, expect, afterAll } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHyper, getHyperdPath } from "./loader.ts";

const { HyperProcess, Connection, CreateMode, SqlType, TableDefinition, Catalog, RowInserter } = await loadHyper();

const dbPath = join(tmpdir(), `tableau-ai-eval-hyper-roundtrip-${process.pid}.hyper`);

afterAll(() => {
  try {
    rmSync(dbPath, { force: true });
  } catch {}
});

test("RowInserter is available from the installed package", () => {
  expect(RowInserter).toBeDefined();
});

test("concurrent loads share the initialized API", async () => {
  const [first, second] = await Promise.all([loadHyper(), loadHyper()]);
  expect(first).toBe(second);
});

test("getHyperdPath resolves a hyperd binary in dev", () => {
  const p = getHyperdPath();
  expect(p).toBeTruthy();
  expect(p).toContain("hyperd");
});

test("full Hyper round-trip: create -> insert (with NULL) -> query", async () => {
  const hyperPath = getHyperdPath();
  const hyper = new HyperProcess(hyperPath);
  try {
    const conn = await Connection.connect(
      hyper.endpoint,
      dbPath,
      CreateMode.CreateAndReplace,
    );
    try {
      // Table exercising text / bigInt / double / bool.
      const def = new TableDefinition("results").withSchema("public");
      def.addColumn("name", SqlType.text(), false);
      def.addColumn("case_number", SqlType.bigInt(), false);
      def.addColumn("score", SqlType.double(), true); // nullable -> NULL row
      def.addColumn("passed", SqlType.bool(), false);

      await new Catalog(conn).createTable(def);

      const ins = new RowInserter(conn, def);
      ins.addRow(["alpha", 1, 95.5, true]);
      ins.addRow(["beta", 2, null, false]); // NULL score
      const inserted = await ins.execute();
      expect(inserted).toBe(2);

      const rows = await conn.executeQuery(
        'SELECT "name", "case_number", "score", "passed" FROM "public"."results" ORDER BY "case_number"',
      );
      expect(rows.length).toBe(2);

      // Row 0: alpha
      expect(rows[0].getString(0)).toBe("alpha");
      expect(rows[0].getBigInt(1)).toBe(1n);
      expect(rows[0].getFloat64(2)).toBeCloseTo(95.5, 6);
      expect(rows[0].getBool(3)).toBe(true);

      // Row 1: beta, NULL score
      expect(rows[1].getString(0)).toBe("beta");
      expect(rows[1].getBigInt(1)).toBe(2n);
      expect(rows[1].isNull(2)).toBe(true);
      expect(rows[1].getFloat64(2)).toBeNull();
      expect(rows[1].getBool(3)).toBe(false);
    } finally {
      await conn.close();
    }
  } finally {
    hyper.close();
  }
});
