# Agent scoring fixtures

`expected.json` contains 85 distinct recorded calculation and visualization
scoring outcomes. `packages/evals/src/harness/agent_parity.test.ts` replays them
through the native runner and checks emitted scores. Parser diagnostic wording
is not asserted. These are offline regression fixtures; no generator requiring
another source checkout is distributed. See [the fixture guide](../../docs/GOLDENS.md).
