/**
 * Request-shape golden parity test (OFFLINE, DETERMINISTIC).
 *
 * Re-runs the same request-shape generation as `gen_request_shapes.ts` and
 * asserts it matches the committed goldens under `goldens/request_shapes/`. A
 * change to ANY recorded request builder (the CES /conversations payload,
 * or the CABU 3-phase URLs/bodies) trips
 * this test.
 *
 * Lives beside the generator (under `scripts/`, which the root tsconfig
 * includes) so it stays in the typecheck graph; the golden JSON it checks lives
 * under `goldens/request_shapes/`. See that dir's README for the determinism
 * boundary: this pins layer 1 (what we SEND), a pure function of case + config.
 * It does NOT pin the model's reply or any LLM-scored/judge metric.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildGoldens,
  REQUEST_SHAPES_DIR,
  type RequestShapeGolden,
} from "./gen_request_shapes.ts";

function readGolden(name: string): RequestShapeGolden {
  const raw = readFileSync(join(REQUEST_SHAPES_DIR, `${name}.json`), "utf8");
  return JSON.parse(raw) as RequestShapeGolden;
}

const SLICE_NAMES = [
  "cabu_three_phase",
  "nlq_calc_with_datasource",
  "nlq_multistep",
  "nlq_palette",
].sort();

describe("request-shape goldens (evaluation runners)", () => {
  test("every generated slice matches its committed golden", async () => {
    const generated = await buildGoldens();
    expect(Object.keys(generated).sort()).toEqual(SLICE_NAMES);
    for (const name of SLICE_NAMES) {
      expect(generated[name]).toEqual(readGolden(name));
    }
  });

  test("both request builders are represented", async () => {
    const generated = await buildGoldens();
    const adapters = new Set(Object.values(generated).map((g) => g.adapter));
    expect([...adapters].sort()).toEqual(["cabu", "nlq"]);
  });

  test("nlq calc path indexes the datasource then posts the conversation", () => {
    const g = readGolden("nlq_calc_with_datasource");
    const paths = g.requests.map((r) => `${r.method} ${r.pathAndQuery}`);
    expect(paths).toEqual([
      "POST /content-exploration/analytics-assistant/datasources",
      "POST /content-exploration/analytics-assistant/datasources/ect-golden/fields",
      "POST /content-exploration/analytics-assistant/conversations",
    ]);
    const convo = g.requests[2]!.body as { datasourceECTId: string };
    expect(convo.datasourceECTId).toBe("ect-golden");
  });

  test("palette case posts {utterance, paletteType} to the palette generate endpoint", () => {
    const g = readGolden("nlq_palette");
    expect(g.requests).toHaveLength(1);
    const req = g.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.pathAndQuery).toBe(
      "/content-exploration/analytics-assistant/color-palettes/generate",
    );
    expect(req.body).toHaveProperty("paletteType");
    expect(req.body).toHaveProperty("utterance");
  });

  test("cabu is the three-phase create → utterance → stream", () => {
    const g = readGolden("cabu_three_phase");
    expect(g.requests.map((r) => r.method)).toEqual(["POST", "POST", "GET"]);
    expect(g.requests[2]!.pathAndQuery.endsWith("/stream")).toBe(true);
  });
});
