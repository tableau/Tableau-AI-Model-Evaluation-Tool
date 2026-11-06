# Narrative regression fixtures

`expected.json` records 33 summaries and 165 deterministic metric results in
dependency-free regex date-detection mode. `request_expected.json` pins the
request contract; `judge_expected.json` pins judge parsing and score formulas,
not nondeterministic model outputs. All replay tests run offline.

See [the fixture guide](../../docs/GOLDENS.md) for fixture maintenance.
