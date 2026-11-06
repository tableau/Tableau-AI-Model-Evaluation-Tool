import { expect, test } from "bun:test";
import type { RowPayload } from "@tableau-ai-eval/core";
import goldens from "../../../../goldens/prep/server_expected.json";
import type { PrepRecord, SuiteKind } from "../prep/bench.ts";
import { prepServerRequest, scorePrepServerRow } from "./prep_server.ts";

for (const golden of goldens.rows) {
  test(`Prep server reference parity: ${golden.kind} ${golden.record.case_id}`, () => {
    const kind = golden.kind as SuiteKind;
    const record = golden.record as PrepRecord;
    expect(prepServerRequest(kind, record)).toEqual(golden.request);

    const row: RowPayload = {
      test_case_id: record.case_id as string,
      runner: `prep-${kind}`,
      datasource: null,
      utterance: record.canonical,
      expected: {},
      actual: {},
      latency: null,
      turn: 0,
      debug_info: {},
      info: {},
      errors: [],
      metrics: {},
    };
    scorePrepServerRow(kind, record, row, golden.body);
    expect(row.actual).toEqual(golden.row.actual);
    expect(JSON.stringify(row.metrics)).toBe(JSON.stringify(golden.row.metrics));
    expect(row.errors).toEqual(golden.row.errors);
  });
}
