/**
 * Prep dataset-panel regression tests.
 * Every flow and step-data file a shipped Prep case names opens from the results page under
 * the name its row shows.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";
import { flattenPrepSuite, prepCasesBase, prepDataName } from "@tableau-ai-eval/evals";
import { getPrepDataset, listPrepDatasets } from "./prep_datasets.ts";

test("prep data opens in the datasource panel", () => {
  const listed = new Map(listPrepDatasets().map((d) => [d.id, d]));
  const cases = prepCasesBase()!;
  for (const kind of ["calc-gen", "flow-plan-gen"] as const) {
    for (const { record } of flattenPrepSuite(join(cases, kind), kind)) {
      const shown = prepDataName(record);
      if (shown !== null) {
        expect(listed.has(shown)).toBe(true);
        expect(listed.get(shown)!.field_count).toBeGreaterThan(0);
      }
    }
  }

  const flow = getPrepDataset("HospitalAdmissions.tflx")!;
  // fields come from the data file packaged in the flow, not the template
  expect(flow.fields[0]!.name).toBe("Patient Admitted");
  expect(flow.note).toContain("flow");

  const several = getPrepDataset("SuperstoreOneOutput.tflx")!;
  expect(new Set(several.fields.map((f) => f.key)).size).toBe(several.fields.length);
  expect(several.fields[0]!.description.startsWith("Input step:")).toBe(true);

  const steps = getPrepDataset("website-traffic.txt")!;
  const byName = new Map(steps.fields.map((f) => [f.name, f]));
  expect(byName.get("Bounce Rate (%)")!.datatype).toBe("real");
  expect(byName.get("Date")!.sample_values[0]).toBe("2024-09-01");
  expect(getPrepDataset("no-such-file.txt")).toBeNull();
  expect(getPrepDataset("../README.md")).toBeNull();
});
