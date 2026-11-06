# Prep regression fixtures

- `inputs_checker.json` and `expected_checker.json` pin calculation validity,
  token similarity, field metadata, and intent normalization.
- `server_expected.json` pins nine server requests and scored answers.

Tests use checked-in data and native code only. Historical reference generators
requiring unavailable sources are not distributed. See [the fixture guide](../../docs/GOLDENS.md).
