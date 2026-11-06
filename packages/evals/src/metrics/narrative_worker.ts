/** CPU-only worker entrypoint: deliberately imports no adapter or credentials. */
import { computeNarrativeMetricGroup } from "./narrative.ts";
import type { NarrativeWorkerRequest, NarrativeWorkerResponse } from "./narrative_pool.ts";

declare const self: {
  onmessage: (event: MessageEvent<NarrativeWorkerRequest>) => void;
  postMessage: (response: NarrativeWorkerResponse) => void;
};

self.onmessage = (event: MessageEvent<NarrativeWorkerRequest>) => {
  const { id, group, views, expected, actual } = event.data;
  let response: NarrativeWorkerResponse;
  try {
    response = { id, metrics: computeNarrativeMetricGroup(group, views, expected, actual) };
  } catch (error) {
    response = { id, error: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
