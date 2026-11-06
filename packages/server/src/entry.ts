/**
 * Smoke-test entrypoint for the compiled binary.
 *
 * Proves lazy native loading and a full Hyper round-trip work in development
 * and from a standalone executable with the downloaded, pinned npm package.
 *
 * It also touches the SQLite + SSE cores so a regression in those surfaces
 * shows up in the smoke run too.
 *
 * Exit code 0 = all good; non-zero on any failure.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { loadHyper, getHyperdPath } from "./hyper/loader.ts";
import { AiEvalDb } from "@tableau-ai-eval/core";
import { SseState } from "@tableau-ai-eval/core";

function log(msg: string) {
  process.stdout.write(msg + "\n");
}

async function hyperRoundTrip(): Promise<void> {
  const { HyperProcess, Connection, CreateMode, SqlType, TableDefinition, Catalog, RowInserter } = await loadHyper();
  const hyperdPath = getHyperdPath();
  log(`hyperd path: ${hyperdPath ?? "(null — relying on addon default)"}`);

  const dbPath = join(tmpdir(), `tableau-ai-eval-smoke-${process.pid}.hyper`);
  const hyper = new HyperProcess(hyperdPath);
  try {
    const conn = await Connection.connect(
      hyper.endpoint,
      dbPath,
      CreateMode.CreateAndReplace,
    );
    try {
      const def = new TableDefinition("results").withSchema("public");
      def.addColumn("name", SqlType.text(), false);
      def.addColumn("case_number", SqlType.bigInt(), false);
      def.addColumn("score", SqlType.double(), true);
      def.addColumn("passed", SqlType.bool(), false);
      await new Catalog(conn).createTable(def);

      const ins = new RowInserter(conn, def);
      ins.addRow(["alpha", 1, 95.5, true]);
      ins.addRow(["beta", 2, null, false]);
      const inserted = await ins.execute();

      const rows = await conn.executeQuery(
        'SELECT "name", "score" FROM "public"."results" ORDER BY "case_number"',
      );
      const name0 = rows[0].getString(0);
      const nullScore = rows[1].isNull(1);
      if (inserted !== 2 || name0 !== "alpha" || !nullScore) {
        throw new Error(
          `Hyper round-trip mismatch: inserted=${inserted} name0=${name0} nullScore=${nullScore}`,
        );
      }
      log(`Hyper round-trip OK: ${inserted} rows, NULL preserved.`);
    } finally {
      await conn.close();
    }
  } finally {
    hyper.close();
    try {
      rmSync(dbPath, { force: true });
    } catch {}
  }
}

function sqliteAndSseSmoke(): void {
  const db = new AiEvalDb(":memory:");
  db.initDb();
  db.createRun({
    job_id: "smoke",
    org_id: "o",
    user_id: "u",
    ai_feature: "nlq",
    runner_name: "r",
    config: { hello: "world" },
  });
  const run = db.getRun("smoke");
  if (!run || run.job_id !== "smoke") throw new Error("SQLite smoke failed");

  const state = new SseState(db);
  state.appendEvent("smoke", { type: "start" });
  state.appendEvent("smoke", { type: "done" });
  const evs = state.getEvents("smoke");
  if (evs.length !== 2 || evs[0].type !== "start") {
    throw new Error("SSE smoke failed");
  }
  db.close();
  log("SQLite + SSE smoke OK.");
}

async function main() {
  log("Tableau AI Model Evaluation Tool smoke test");
  sqliteAndSseSmoke();
  await hyperRoundTrip();
  log("ALL SMOKE CHECKS PASSED");
}

main().catch((err) => {
  process.stderr.write(`SMOKE FAILED: ${err?.stack ?? err}\n`);
  process.exit(1);
});
