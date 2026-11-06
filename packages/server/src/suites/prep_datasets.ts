/**
 * The data behind the Tableau Prep cases, for the results page's Datasource
 * panel.
 *
 * Two kinds, both read from the Prep bench folder (`prep-bench/`):
 *
 * - **Flows** ("Calculated fields in flows"): a case names a packaged flow
 *   such as `SuperstoreOneOutput.tflx`. The flow files are not shipped; each
 *   has a small description in `flows/<name>.json` (its input steps, their
 *   fields and a few values).
 * - **Step data** ("Plan a flow"): a case names a text file under
 *   `test/test-data/flow-plan-gen/step-data/`, which is exactly what the model
 *   is shown: the step the user is on, its fields and its rows.
 *
 * Both are served in the shape the panel draws for the public datasets. A
 * dataset's id is the file name the Datasource column shows, and is looked up
 * in the lists below, never turned into a path.
 */

import { basename, join } from "node:path";
import { contentReaddir, contentReadText } from "@tableau-ai-eval/core";
import { prepRoot } from "@tableau-ai-eval/evals";

const MAX_SAMPLE_VALUES = 8;
const MAX_VALUE_CHARS = 80;

const STEP = /<Step\b([^>]*)>([\s\S]*?)<\/Step>/g;
const ATTRIBUTE = /(\w+)="([^"]*)"/g;
/** A step-data header cell: "Bounce Rate (%) (real)" -> name, data type. */
const TYPED_FIELD = /^([\s\S]*) \(([^()]*)\)$/;

const FLOW_NOTE =
  "This is the Tableau Prep flow these test cases are about: the fields of " +
  "each input step, with a few values from its data. The model is shown the " +
  "field list written in each test case, not the flow file.";
const STEP_DATA_NOTE =
  "This is the step data the model is shown for these test cases: the flow " +
  "step the user is on, its fields and a few values from its rows.";

export interface PrepDatasetField {
  key: string;
  name: string;
  description: string;
  role: string;
  datatype: string;
  default_aggregation: string;
  distinct_count: null;
  sample_values: string[];
  value_count: number;
}

function benchRoot(override?: string | null): string | null {
  if (override !== undefined) return override;
  try {
    return prepRoot({});
  } catch {
    return null;
  }
}

function listFiles(dir: string, ext: string): string[] {
  try {
    return contentReaddir(dir)
      .filter((n) => n.endsWith(ext))
      .sort();
  } catch {
    return [];
  }
}

/** Dataset id (the flow's file name) -> its description file. */
function flowFiles(root: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!root) return out;
  const folder = join(root, "flows");
  for (const name of listFiles(folder, ".json")) out.set(`${name.slice(0, -5)}.tflx`, join(folder, name));
  return out;
}

/** Dataset id (the step-data file's name) -> the file. */
function stepDataFiles(root: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!root) return out;
  const folder = join(root, "test", "test-data", "flow-plan-gen", "step-data");
  for (const name of listFiles(folder, ".txt")) out.set(name, join(folder, name));
  return out;
}

function clip(value: unknown): string {
  const text = String(value);
  const chars = [...text];
  return chars.length <= MAX_VALUE_CHARS ? text : `${chars.slice(0, MAX_VALUE_CHARS - 1).join("").trimEnd()}…`;
}

function field(key: string, name: string, datatype: string, values: unknown[], description = ""): PrepDatasetField {
  const shown = values.slice(0, MAX_SAMPLE_VALUES);
  return {
    key,
    name,
    description,
    role: "",
    datatype: datatype || "",
    default_aggregation: "",
    distinct_count: null,
    sample_values: shown.map(clip),
    value_count: shown.length,
  };
}

function flowFields(path: string): PrepDatasetField[] | null {
  let described: unknown;
  try {
    described = JSON.parse(contentReadText(path));
  } catch {
    return null;
  }
  const inputs = described && typeof described === "object" ? (described as { inputs?: unknown }).inputs : null;
  if (!Array.isArray(inputs)) return null;
  const several = inputs.length > 1;
  const fields: PrepDatasetField[] = [];
  inputs.forEach((step: { name?: string; fields?: { name?: string; datatype?: string; values?: unknown[] }[] }, i) => {
    const seen = new Set<string>();
    for (const f of step.fields ?? []) {
      const name = f.name;
      // A data file may repeat a column name; one row per name is enough.
      if (!name || seen.has(name)) continue;
      seen.add(name);
      fields.push(
        field(`${i}:${name}`, name, f.datatype || "", f.values || [], several ? `Input step: ${step.name}` : ""),
      );
    }
  });
  return fields;
}

/** Python's csv.reader over a block of lines (comma, double-quote quoting). */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
      continue;
    }
    if (c === '"' && cell === "") {
      quoted = true;
      started = true;
    } else if (c === ",") {
      row.push(cell);
      cell = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || cell !== "") row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      started = false;
    } else {
      cell += c;
      started = true;
    }
  }
  if (started || cell !== "") row.push(cell);
  if (row.length) rows.push(row);
  return rows;
}

function stepDataFields(path: string): PrepDatasetField[] | null {
  let text: string;
  try {
    text = contentReadText(path).replace(/^\uFEFF/, "");
  } catch {
    return null;
  }
  const steps = [...text.matchAll(STEP)];
  const several = steps.length > 1;
  const fields: PrepDatasetField[] = [];
  steps.forEach(([, attributes, body], i) => {
    const attrs = Object.fromEntries([...attributes!.matchAll(ATTRIBUTE)].map((m) => [m[1]!, m[2]!]));
    const rows = csvRows(body!.trim()).filter((r) => r.length);
    if (!rows.length) return;
    const label = [attrs.type, attrs.name ? `"${attrs.name}"` : ""].filter((x) => x).join(" ");
    const seen = new Set<string>();
    rows[0]!.forEach((cell, column) => {
      const m = TYPED_FIELD.exec(cell.trim());
      const [name, datatype] = m ? [m[1]!, m[2]!] : [cell.trim(), ""];
      if (!name || seen.has(name)) return;
      seen.add(name);
      const values: string[] = [];
      for (const r of rows.slice(1)) {
        const value = column < r.length ? r[column]!.trim() : "";
        if (value && !values.includes(value)) values.push(value);
        if (values.length >= MAX_SAMPLE_VALUES) break;
      }
      fields.push(field(`${i}:${name}`, name, datatype, values, several ? label : ""));
    });
  });
  return fields;
}

/** The flows and step-data files a Prep case can name: id, display name, field count. */
export function listPrepDatasets(root?: string | null): { id: string; name: string; field_count: number }[] {
  const r = benchRoot(root);
  const out: { id: string; name: string; field_count: number }[] = [];
  for (const [id, path] of flowFiles(r)) {
    const fields = flowFields(path);
    if (fields?.length) out.push({ id, name: id, field_count: fields.length });
  }
  for (const [id, path] of stepDataFiles(r)) {
    const fields = stepDataFields(path);
    if (fields?.length) out.push({ id, name: basename(id, ".txt"), field_count: fields.length });
  }
  return out;
}

/** One flow or step-data file as the panel draws it; null for an unknown id. */
export function getPrepDataset(
  identifier: string,
  root?: string | null,
): { id: string; name: string; note: string; fields: PrepDatasetField[] } | null {
  const r = benchRoot(root);
  const flow = flowFiles(r).get(identifier);
  if (flow !== undefined) {
    const fields = flowFields(flow);
    return fields === null ? null : { id: identifier, name: identifier, note: FLOW_NOTE, fields };
  }
  const steps = stepDataFiles(r).get(identifier);
  if (steps !== undefined) {
    const fields = stepDataFields(steps);
    return fields === null ? null : { id: identifier, name: basename(identifier, ".txt"), note: STEP_DATA_NOTE, fields };
  }
  return null;
}
