# Metric regression fixtures

Hand-built expected/actual pairs and inline datasource fields in `inputs.json`
are compared with the historical reference scores in `expected.json` by
`packages/evals/src/metrics/golden_parity.test.ts`. No live services or external
source checkout are required.

See [the fixture guide](../../docs/GOLDENS.md).
