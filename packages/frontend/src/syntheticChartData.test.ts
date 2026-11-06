import { describe, expect, test } from "bun:test";
import registrationsCase from "../../../public-suites/vizgen/cases/set-01/public-edx-courses_10.json";
import { generateSyntheticRows, type PreviewField } from "./syntheticChartData.ts";

describe("synthetic chart preview data", () => {
  const fields = registrationsCase.inputs[0].expected.notionalSpec.fields;

  test("registrations preview is identical when the model reverses the fields", () => {
    expect(generateSyntheticRows([...fields].reverse())).toEqual(generateSyntheticRows(fields));
  });

  test("values do not depend on axes, aggregation, or unrelated fields", () => {
    const baseline = generateSyntheticRows(fields);
    const changed = generateSyntheticRows([
      { caption: "Other measure", data: "number" },
      ...fields.map((f) => ({ ...f, encoding: f.encoding === "x" ? "y" : "x", aggregation: "avg" })),
    ]);
    for (let i = 0; i < baseline.length; i++) {
      expect(changed[i].Registrations).toBe(baseline[i].Registrations);
      expect(changed[i]["Level of Education"]).toBe(baseline[i]["Level of Education"]);
    }
  });

  test("generation is repeatable and distinct measures have distinct values", () => {
    const measures: PreviewField[] = [
      { caption: "Registrations", data: "number" },
      { caption: "Explorers", role: "measure" },
    ];
    const rows = generateSyntheticRows(measures);
    expect(generateSyntheticRows(measures)).toEqual(rows);
    expect(generateSyntheticRows([...measures].reverse())).toEqual(rows);
    expect(rows.map((r) => r.Registrations)).not.toEqual(rows.map((r) => r.Explorers));
  });

  test("date fields, temporal aggregations, and categories retain their sample data", () => {
    const rows = generateSyntheticRows([
      { caption: "Date", data: "date" },
      { caption: "Quarter", aggregation: "qtr" },
      { caption: "Category", data: "string" },
    ], 2);
    expect(rows).toEqual([
      { Date: "2020-01-15", Quarter: "2020-01-15", Category: "Alpha" },
      { Date: "2021-02-15", Quarter: "2021-02-15", Category: "Beta" },
    ]);
    expect(generateSyntheticRows([], 0)).toEqual([]);
  });
});
