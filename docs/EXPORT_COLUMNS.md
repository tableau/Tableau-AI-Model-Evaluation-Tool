# Export and publish columns (schema version 3)

An evaluation run leaves the tool in three shapes: a **CSV** export, a **JSON**
export (`GET /nlq-eval/export/<job_id>?format=csv|json`) and rows appended to
the **"AI Model Evaluation Results"** datasource in the **"AI Model
Evaluations"** project on Tableau Server (`POST /nlq-eval/publish/<job_id>`).
All three render one record model, `packages/server/src/publish/records.ts`,
so the run and case columns are
identical in the CSV and the datasource, in the order below. Scores are
fractions from 0 to 1; times are UTC.

- **CSV**: one row per case — the run's identity repeated on every row, then
  the case columns, then one column per metric named `<stage>.<metric_name>`
  (`llmJudge.coherence`), holding the score, the word `Unavailable` where a
  judge metric exists but could not be scored, or empty where it was not
  computed. A row is about one case, so it carries no run averages or totals.
- **JSON**: `{schema_version, run, summary, cases, metric_dictionary,
  column_dictionary}`. `run` has the run columns (plus JSON-only `suite_id`,
  `suite_label`, `models`, `declared_site_model`, `resolved_site_model`,
  `batch_id` and `local` {test_path, runner}); `summary` has the run's
  averages and totals, once: the two quality-card scores, the
  `headline_scores` (the capability's own averages, `[{key, label,
  average, total_scores, judge_scores}]` — how many metrics each average is
  over and how many of them the LLM judge scored, so a judge-on run is not
  read against a judge-off one), per-category and per-metric averages, verdict counts and
  bands, case totals and average latency (no blended overall score since
  schema 3); each case nests its
  `metrics` (the metric columns).
- **Datasource**: ONE long-form table, `results`, one row per case × metric
  (a metric-less case keeps one row with NULL metric fields). Timestamps are
  real `TIMESTAMP_TZ` values. The table is append-forever: its columns change
  only with a new schema version.

File names say what they hold: `ai-model-eval_<suite>_<model>_<date>_<run id prefix>`.

## Scores

Every score derives from the metric catalog
(`packages/core/src/metrics/catalog.json`; the results page reads a copy at
`packages/frontend/src/metricCatalog.json`), so the number on the results
page, the home page history, both exports and the datasource agree.
There is no single blended number per run: the home page lists each
capability's own averages (Calculated fields, Visualization quality, Intent
and spec, Natural language quality and so on) — the JSON summary's
`headline_scores`. In an export or the published datasource, compare those:
average `score` by `metric_category` for each `run_id`. Compare only between
runs with the same `capability`, the same `suite_case_count` and the same
`tableau_site`. Leave out partial runs: a run is complete when its count of
distinct `test_case_id` values equals `suite_case_count`. `case_score` is
one case's category averages weighted by the category weights (the
natural-language categories weigh 0).

## Schema tag

The datasource is tagged `ai-model-eval-schema-3` when created. If a
datasource of that name exists in the project without the tag, it was made by
an earlier version of the tool (with a different column set), and publishing
stops with HTTP 409 `{"reason": "schema_mismatch"}` and a message saying to
rename or delete that datasource on the server, then publish again.

## The run

Repeated on every row, so a row is complete on its own.

| Column | Type | Meaning |
|---|---|---|
| `schema_version` | int | Version of this column set. Rows with different versions are not in the same table. |
| `run_id` | text | The run's identifier. Every row of one run carries the same value; filter on it to see one run. |
| `tool_version` | text | Version of the evaluation tool that produced the run. |
| `run_status` | text | How the run ended: Completed, Paused, Canceled, or Failed; In progress or Queued for a run exported before it ended. |
| `run_started_at` | timestamp | When the run was launched (UTC). |
| `run_finished_at` | timestamp | When the run ended (UTC); empty while it is still going or paused. |
| `run_duration_s` | double | Seconds from launch to end; empty until the run has ended. |
| `exported_at` | timestamp | When this file or publish was produced (UTC). |
| `tableau_server_url` | text | The Tableau Server whose AI settings were under test. |
| `tableau_site` | text | The site under test (its name in the URL; Default for the default site). |
| `tableau_site_luid` | text | The site's identifier on the server. |
| `tableau_server_version` | text | The server's product version and build at the time of the run, as the server reports them: 2026.1.0 (20261.26.0415.1010). |
| `capability` | text | The AI capability the suite exercises (calc, viz-authoring, palettes, ...). |
| `capability_label` | text | The capability as the site settings name it (Calculated fields, Build a visualization, ...). |
| `suite_case_count` | int | How many cases the suite has. A run with fewer rows than this (count the distinct test_case_id values) is partial. |
| `model_under_test` | text | The model that answered: the model the site had configured, read from Site Settings when the run started. |
| `model_provider` | text | The provider configured for the model, when the site settings say. |
| `answered_by` | text | The address the tool sent the questions to: the Tableau Server endpoint that passes them to the site's model. |
| `judge_provider` | text | Provider of the LLM judge that scored the natural-language metrics; empty when no judge ran. |
| `judge_model` | text | The judge model; empty when no judge ran. |

## The case

| Column | Type | Meaning |
|---|---|---|
| `case_number` | int | Position of the case in the run. |
| `test_case_id` | text | The case's identifier in the suite; stable across runs of the suite. |
| `datasource` | text | The data source the case asks about. |
| `utterance` | text | The question or request sent to the AI feature. |
| `expected_kind` | text | What the case expects back: formula, viz_spec, plan, palette, narrative, reply or intent. |
| `expected` | json | The known-good answer, as JSON. |
| `actual` | json | What the model produced, as JSON; empty when the case errored. |
| `latency_s` | double | Seconds the server took to answer this case. |
| `case_status` | text | scored (has a score), error (no score, hit an error), unavailable (only judge scores, all failed), or unscored (nothing to score, or the suite gives no expected answer for the case). |
| `case_score` | double | The case's overall score, 0 to 1: its category averages weighted by the category weights (metric_category_weight). |
| `case_verdict` | text | pass, partial or fail on case_score (provisional bands: pass at 0.66 and above, partial at 0.33 and above); na without a score. |
| `error_count` | int | Errors this case hit. |
| `warning_count` | int | Warnings this case raised (not errors). |
| `errors_text` | text | The error messages, separated by ' \| '. |
| `case_tags` | text | Reserved for case labels (intent, operation, output type); empty for now. |

## The metric

In the datasource each metric is its own row with these columns; in the CSV
each metric is a `<stage>.<metric_name>` column; in the JSON they are nested
under each case.

| Column | Type | Meaning |
|---|---|---|
| `metric_stage` | text | The metric's stage in the evaluator (llmJudge = judge-scored). |
| `metric_name` | text | The metric's name in the evaluator. |
| `metric_id` | text | The evaluator's identifier for the metric implementation. |
| `metric_label` | text | The metric's display name, as the results page shows it. |
| `metric_category` | text | The category the metric rolls up into (Calculated Fields, Data, Design, ...). |
| `metric_category_weight` | int | The category's weight in the overall score; 0 for natural-language categories. |
| `score` | double | The metric's score, 0 to 1; empty when the judge could not score the case (see unavailable). |
| `judge_derived` | bool | True when an LLM judge produced the score. |
| `unavailable` | bool | True when a judge metric exists for the case but the judge call failed (score empty). |
| `explanation` | text | The scorer's explanation of the score, when it gave one. |
