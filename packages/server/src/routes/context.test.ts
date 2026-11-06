import { expect, test } from "bun:test";
import { AiEvalDb, SseState } from "@tableau-ai-eval/core";
import { JobQueue } from "../worker/queue.ts";
import { createRoutesContext } from "./context.ts";

test("resume uses the saved token for its own server/site, never the active connection's token", () => {
  const db = new AiEvalDb(":memory:");
  db.initDb();
  try {
    db.setSetting("tableau", {
      server_url: "https://active",
      site: "onprem",
      pat_name: "active",
      pat_value: "active-secret",
    });
    db.setSetting("tableau_connections", [
      {
        server_url: "https://cloud",
        site: "cloud-site",
        pat_name: "cloud",
        pat_value: "cloud-secret",
      },
    ]);
    const ctx = createRoutesContext({
      db,
      sse: new SseState(db),
      queue: new JobQueue({ acquireInhibitor: () => ({ release() {} }) }),
      suiteBases: { publicBase: null },
    });
    const config = ctx.mergeTableauSettings({
      tableau_server: "https://cloud",
      tableau_site: "cloud-site",
      tableau_pat_value: "****",
    });
    expect(config.tableau_pat_name).toBe("cloud");
    expect(config.tableau_pat_value).toBe("cloud-secret");
    expect(
      ctx.mergeTableauSettings({ tableau_server: "https://unknown" }).tableau_pat_value,
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
