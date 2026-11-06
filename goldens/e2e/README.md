# Recorded evaluation replay fixtures

`case_responses.json`, `py_results.json`, and `ces_fixtures/` retain a recorded
evaluation slice and independent reference scores. Credentials are not needed:
`scripts/golden/replay_parity.ts` and its tests replay the responses offline.
Request hosts are illustrative and must not be treated as accessible servers.

Historical live-capture and private-source scoring generators are not distributed.
See [the fixture guide](../../docs/GOLDENS.md).
