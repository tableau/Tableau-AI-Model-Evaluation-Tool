# Build a visualization suite

This suite tells a server administrator how well the site's configured AI
model builds charts: the visualization a user gets when they ask Tableau
Agent in Authoring a question about their data. Run it before turning the
feature on for your users, or after changing the site's model, and read the
score against the baseline the tool shows.

## What you need

- **Tableau Server 2026.4 or later.** The suite calls Tableau Agent's
  conversation endpoint, which earlier releases do not have; the tool's
  connection test says *server too old* on such a release and keeps every
  suite disabled.
- **Tableau Agent in Authoring turned on** for the site and for the account
  whose Personal Access Token the tool uses: Site Settings → AI in Tableau.
  When it is off, every case fails with a message saying so.
- **An evaluator model** (Settings → Evaluator model) if you want the judged
  scores on the reply the model writes with its answer. Without one the
  deterministic scores still run.
- Nothing on your site. The tool sends the server a *description* of each
  sample dataset (its fields and a few sample values, from
  `../fixtures/`); the server's AI answers about that description, and no
  data source is published to your site.

## What the suite does

1,160 cases in 838 conversations (some questions have follow-ups: "now only
2024", "sort by sales"), each a question about one of seven public sample
datasets with the chart an expert would build: its type, fields, filters,
sort and styling. The tool registers the dataset's description with your
server, asks the questions in order, and scores each chart definition the
site's model returns. A run takes about four hours (fourteen seconds per case
in the median); it can be paused and resumed. The datasets are listed in
[../README.md](../README.md).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Field similarity | The chart uses the fields the expert's chart uses, on the same channels (axes, color, size, tooltip) | The chart answers a different question than the one asked |
| Chart similarity | The chart type is the expected one | A bar where a line was called for |
| Filter | The chart applies the filters the question implied (values, dates, ranges) | Unfiltered or over-filtered data |
| Sort | The sort is the expected one | Rankings in the wrong order |
| Axis accuracy | The fields on the axes, with their aggregation, are the expected ones | Sums where averages were asked for, or the wrong measure |
| Aesthetic, Tooltip | Color, size and tooltip encodings match the expert's | Charts that need manual styling |
| Information similarity | The reply the model writes with the chart says what the expected chart shows | Replies that do not describe the chart |
| Intent match, Spec precision / recall, Spec field validity | The request was recognised as a chart and the chart names real, expected fields | Shown for reference beside Visualization quality; not in its average |
| Coherence, Factual grounding (judge) | The reply is clear and true to the chart | Replies users cannot rely on |

The tool shows one Visualization quality score per run (data, semantics,
functionality and design, weighted) against the baseline the tool shows; open any case
to see the chart definition next to the expert's, drawn as a chart, with the
fields the server offered the model and the reason for each score. The drawing
uses sample rows, not your data; the filters and the sort of each chart
definition are written under it.

Three rules of the scoring worth knowing when you read a case:

- **A follow-up the model answers without a chart.** When a follow-up asks for
  something the chart already shows ("also include CS" when CS is the only
  subject shown), Tableau Agent replies in words and leaves the chart as it
  is. The case shows *Unchanged from the previous turn* with that chart, and
  the scores compare it, since it is what a user sees. The same happens when
  the model declines a follow-up: the chart it left in place is scored against
  the chart the expert expected after the request, so a declined change still
  costs the score. On a first question, no chart is simply no chart.
- **Relative dates.** A request for "this year", "last quarter" or "the past
  2 years" expects a relative date filter, the way Tableau Agent writes one.
  The current period ("this year") also counts as a match when the model
  writes it as the calendar year of the day the evaluation runs.
- **No chart family expected.** Eight cases ask a question any chart can
  answer ("total amount in the last 5 years"); they are not scored on Chart
  similarity.
