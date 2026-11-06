/**
 * The Prep test bench that ships with the tool (`prep-bench/` at the repo
 * root, embedded in the binary when compiled): where it is and how its suites
 * are read.
 *
 * Nothing here chdirs: every bench path is
 * resolved against the root explicitly.
 */

import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { RunConfig } from "@tableau-ai-eval/core";
import { bundledContentRoot, contentIsDir, contentReaddir, contentReadText } from "@tableau-ai-eval/core";
import { bundledDir } from "../public_suites.ts";

export const SUITE_KINDS = ["calc-gen", "flow-plan-gen", "intent-gen"] as const;
export type SuiteKind = (typeof SUITE_KINDS)[number];

const isDir = contentIsDir;

function isCompiled(): boolean {
  const b = (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun;
  if (b && typeof b.isStandaloneExecutable === "boolean") return b.isStandaloneExecutable;
  const u = import.meta.url;
  return u.includes("/$bunfs/") || u.includes("/~BUN/") || u.includes("B~");
}

/** A bench folder: it has the flows and the step data. */
function isBench(p: string): boolean {
  return isDir(join(p, "test", "test-data"));
}

/**
 * `prep-bench/`: the copy of the bench that ships with the tool (embedded in the
 * executable when compiled, at the repository root otherwise). Null when it
 * is not on disk.
 */
export function bundledPrepRoot(): string | null {
  const base = isCompiled()
    ? (bundledContentRoot() ?? dirname(process.execPath))
    : resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
  const p = join(base, "prep-bench");
  return isDir(p) ? p : null;
}

/**
 * Resolve the bench folder: an explicit override (run config `prep_root`,
 * then `$TABLEAU_AI_EVAL_PREP_ROOT`), then the copy shipped with the tool.
 */
export function prepRoot(config: RunConfig = {}, env: NodeJS.ProcessEnv = process.env): string {
  const candidates = [config.prep_root, env.TABLEAU_AI_EVAL_PREP_ROOT, bundledPrepRoot()];
  for (const c of candidates) {
    if (typeof c === "string" && c && isBench(c)) return resolve(c);
  }
  throw new Error(
    "Prep test bench not found: the tool's prep-bench folder is missing — " +
      "set config 'prep_root' or $TABLEAU_AI_EVAL_PREP_ROOT to a bench folder",
  );
}

/**
 * Where the Prep suites' cases are: `public-suites/prep` (the only copy the
 * tool ships), or `<bench>/test/test-cases` of a bench named by
 * `$TABLEAU_AI_EVAL_PREP_ROOT` when that folder exists. Null when neither does.
 */
export function prepCasesBase(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.TABLEAU_AI_EVAL_PREP_ROOT) {
    try {
      const base = join(prepRoot({}, env), "test", "test-cases");
      if (isDir(base)) return base;
    } catch {
      // no bench there: fall through to the shipped cases
    }
  }
  return bundledDir("prep");
}

/**
 * Resolve the suite directory and its kind (calc-gen | flow-plan-gen |
 * intent-gen). Accepts an absolute/relative dir or a bare suite name.
 * An explicit `suite_kind` names the kind of a directory with another name.
 */
export function resolveSuite(config: RunConfig, root: string | null): { dir: string; kind: SuiteKind } {
  const raw = String(config.test_path || config.test_cases_dir || "").trim();
  if (!raw) throw new Error("prep adapter requires test_path (suite dir or name)");
  let dir: string;
  if ((SUITE_KINDS as readonly string[]).includes(raw)) {
    // A bench named in the run config may carry its own cases; the shipped
    // bench does not, its cases are public-suites/prep.
    const explicitCases = root ? join(root, "test", "test-cases") : null;
    const base = (config.prep_root && explicitCases && isDir(explicitCases) ? explicitCases : null) ?? prepCasesBase();
    if (!base) throw new Error(`prep suite ${raw}: no Prep cases to find it in (public-suites/prep is missing)`);
    dir = join(base, raw);
  } else {
    dir = isAbsolute(raw) || !root ? raw : join(root, raw);
  }
  const explicit = config.suite_kind;
  const name = basename(dir.replace(/[\\/]+$/, ""));
  const kind = (
    typeof explicit === "string" && (SUITE_KINDS as readonly string[]).includes(explicit) ? explicit : name
  ) as SuiteKind;
  if (!(SUITE_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `prep suite ${dir} must be one of ${SUITE_KINDS.join(", ")} (directory name carries the suite kind)`,
    );
  }
  if (!isDir(dir)) throw new Error(`prep suite directory not found: ${dir}`);
  return { dir, kind };
}

/** A flattened Prep test-case record. */
export interface PrepRecord {
  "test-file"?: string;
  id?: string | null;
  canonical: string;
  description?: string | null;
  "is-followup"?: boolean;
  "expected-calc"?: unknown;
  "flow-name"?: string | null;
  "field-metadata"?: unknown;
  "expected-flow-plan"?: unknown;
  "data-location"?: string | null;
  "expected-intent"?: unknown;
  /** Another fair reading of the request, or an equivalent answer: scored like the expected one (acceptable-*) or with partial credit (plausible-intents). */
  "acceptable-calcs"?: unknown;
  "acceptable-flow-plans"?: unknown;
  "plausible-intents"?: unknown;
  [key: string]: unknown;
}

export interface PrepCase {
  caseId: string;
  record: PrepRecord;
}

/** An expected flow plan: one or more step names. */
export function isStepList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string");
}

/**
 * The (case id, record) pairs of a suite directory, in stable order: each
 * utterance of each test in each `*.yaml` (sorted by name) is a case. A
 * malformed utterance, and a flow-plan case without an expected plan
 * ('TODO'), is skipped. Ids are `<file stem>__<test id>`, `__u<n>` on
 * repeats.
 */
export function flattenSuite(dir: string, kind: SuiteKind, log?: (m: string) => void, multiTurn = false): PrepCase[] {
  const out: PrepCase[] = [];
  const seen = new Map<string, number>();
  let names: string[];
  try {
    names = contentReaddir(dir)
      .filter((n) => n.endsWith(".yaml"))
      .sort();
  } catch {
    return out;
  }
  for (const name of names) {
    const path = join(dir, name);
    let tests: unknown;
    try {
      tests = yaml.load(contentReadText(path)) ?? [];
    } catch (exc) {
      log?.(`Skipping unparseable ${name}: ${exc instanceof Error ? exc.message : exc}`);
      continue;
    }
    if (!Array.isArray(tests)) continue;
    const stem = name.replace(/\.yaml$/, "");
    for (const test of tests) {
      if (!test || typeof test !== "object" || Array.isArray(test)) continue;
      const t = test as Record<string, unknown>;
      let utterances = Array.isArray(t.utterances) ? t.utterances : [];
      if (multiTurn && kind === "intent-gen" && utterances.length === 2) {
        const [first, second] = utterances as Record<string, unknown>[];
        if (Array.isArray(first?.canonical) && first.canonical.length && first.canonical.every(v => typeof v === "string") && second && !("canonical" in second) && "expected-intent" in second) {
          utterances = [{ ...second, canonical: first.canonical.at(-1), history: first.canonical.slice(0, -1) }];
        }
      }
      utterances.forEach((utt, i) => {
        if (!utt || typeof utt !== "object" || typeof (utt as Record<string, unknown>).canonical !== "string") {
          log?.(`Skipping malformed utterance in ${name} (id=${t.id})`);
          return;
        }
        const u = utt as Record<string, unknown>;
        if (kind === "flow-plan-gen" && !isStepList(u["expected-flow-plan"])) {
          log?.(`Skipping ${name} (id=${t.id}): it has no expected flow plan`);
          return;
        }
        const rec: PrepRecord = {
          "test-file": name,
          id: (t.id as string) ?? null,
          canonical: u.canonical as string,
          description: (t.description as string) ?? null,
          "is-followup": i > 0,
        };
        if (kind === "calc-gen") {
          rec["expected-calc"] = u["expected-calc"] ?? null;
          rec["flow-name"] = (t["flow-name"] as string) ?? null;
          rec["field-metadata"] = t["field-metadata"] ?? null;
          if (Array.isArray(u["acceptable-calcs"]) && u["acceptable-calcs"].length) rec["acceptable-calcs"] = [...u["acceptable-calcs"]];
        } else if (kind === "flow-plan-gen") {
          rec["expected-flow-plan"] = u["expected-flow-plan"] ?? null;
          rec["data-location"] = (t["data-location"] as string) ?? null;
          if (Array.isArray(u["acceptable-flow-plans"]) && u["acceptable-flow-plans"].length)
            rec["acceptable-flow-plans"] = u["acceptable-flow-plans"].map(p => (Array.isArray(p) ? [...p] : p));
        } else {
          rec["expected-intent"] = u["expected-intent"] ?? null;
          if (Array.isArray(u["plausible-intents"]) && u["plausible-intents"].length) rec["plausible-intents"] = [...u["plausible-intents"]];
          if (Array.isArray(u.history) && u.history.length) rec.history = u.history;
        }
        // Python f-string of a None id reads "None".
        const base = `${stem}__${t.id ?? "None"}`;
        const n = seen.get(base) ?? 0;
        seen.set(base, n + 1);
        out.push({ caseId: n === 0 ? base : `${base}__u${n}`, record: rec });
      });
    }
  }
  return out;
}

/**
 * What the case's data is called in a row's Datasource column: the flow file
 * of a calculation case, the step-data file of a flow-plan case (its name, not
 * its path inside the bench), nothing for a case with neither.
 */
export function dataName(rec: PrepRecord): string | null {
  const flow = rec["flow-name"];
  if (flow && flow !== "SKIP") return flow; // the bench's marker for "no flow to replay"
  const location = rec["data-location"];
  return location ? basename(location) : null;
}
