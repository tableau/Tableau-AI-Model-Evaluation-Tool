# Request-contract fixtures

These fixtures pin the URL path, method, stable headers, and request body for
NLQ, palette, and dashboard Q&A requests. Ephemeral ids and authentication
headers are normalized. No live server or model is contacted.

`scripts/golden/gen_request_shapes.ts` generates them from this repository's
request builders; `scripts/golden/request_shapes.test.ts` checks for drift.
Regenerate deliberately with `bun scripts/golden/gen_request_shapes.ts` after
reviewing a request-contract change. Independent scoring fixtures are separate.
