import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { publicSuitesRoot } from "./public_content.ts";
import { readExtractRows, unzipEntries } from "./extract_rows.ts";
import { contentReadBytes } from "@tableau-ai-eval/core";

const tdsx = join(publicSuitesRoot() || "", "dashboard-qa", "content", "auto_insurance_claims.tdsx");

// Questions about a dashboard is held back from this release; the extract it
// reads is out of the tree until the suite returns.
describe.skipIf(!existsSync(tdsx))("the rows of a shipped Q&A extract", () => {
  test("a .tdsx unzips to its .tds and .hyper", () => {
    const entries = unzipEntries(contentReadBytes(tdsx));
    const names = [...entries.keys()];
    expect(names.some((n) => n.endsWith(".tds"))).toBe(true);
    expect(names.some((n) => n.endsWith(".hyper"))).toBe(true);
  });

  test("the first rows come back as text with the row count", async () => {
    const page = await readExtractRows(tdsx, 3);
    expect(page.rows).toHaveLength(3);
    expect(page.columns.map((c) => c.name)).toContain("Claim Paid Amount");
    expect(page.total).toBe(17000);
    expect(page.limit).toBe(3);
    for (const row of page.rows) expect(row).toHaveLength(page.columns.length);
  });
});
