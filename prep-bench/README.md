# Prep test content

This folder supplies the sample flows and step data behind the three Tableau
Prep capabilities. The cases themselves live only in `public-suites/prep/` (43
calculation, 47 flow-plan, and 564 intent cases; a case may list accepted
alternative answers).

- `flows/`: a small description of each packaged flow a calculation case names
  (its input steps, their fields and sample rows), shown in the results page's
  Datasource panel.
- `test/test-data/flow-plan-gen/step-data/`: the step data a flow-plan case
  sends to the server, as CSV with the data type after each field name. Most
  files are Preppin' Data community challenges.

The adapter, `packages/evals/src/adapters/prep_server.ts`, sends every request
through Tableau Server's Prep endpoints; the server's own prompts answer them.

Set `TABLEAU_AI_EVAL_PREP_ROOT` to use a different compatible content folder.
Paths resolve against that root, not against the process working directory.

The Prep calculation checker and serializer are in `packages/evals/src/prep/`.
The checked-in grammar is `packages/evals/src/prep/grammar/TableauExpression.g4`;
TypeScript generation is documented in [the grammar guide](../docs/CALC_GRAMMAR.md).
Regression fixtures are described in [the fixture guide](../docs/GOLDENS.md).
