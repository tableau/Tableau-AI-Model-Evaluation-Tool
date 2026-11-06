# Color-palette regression fixtures

Six recorded cases cover regular, sequential, and diverging palettes.
`case_responses.json` retains the colors and `py_results.json` retains independent
deterministic reference scores. `ces_fixtures/` holds scrubbed response fixtures;
request hostnames are illustrative, not live targets.

`scripts/golden/palettes_parity.test.ts` and
`scripts/golden/replay_palettes_parity.ts` compare deterministic palette metrics
offline. The model-scored valid/relevance/design rubric is excluded.
`palette_metric_parity.json` separately pins 103 palettes' tool-level scores,
metric ids, and explanations. See [the fixture guide](../../docs/GOLDENS.md).
