# Plan a flow (Tableau Prep) suite

This suite tells a server administrator how well the site's configured AI
model plans a Tableau Prep flow: the steps a user is offered when they
describe what they want to do with their data. Run it before turning Tableau
Agent in Tableau Prep on for your users, or after changing the site's model,
and read the score against the baseline the tool shows.

## What you need

- **Tableau Server 2026.4 or later.** The suite sends its prompts through the
  server's AI endpoint, which earlier releases do not have; the tool's
  connection test says *server too old* on such a release and keeps every
  suite disabled.
- **A model configured for the site** in Site Settings → AI in Tableau → Model
  Settings; the suite tests the model the site is configured to use.
- **A Personal Access Token** for an account on the site. The tool signs in
  with it; nothing on the site is read or written.

No evaluator model is used: every score is computed by rule.

## What the suite does

47 cases, each a request in words ("remove the duplicate rows and total the
sales by region") with a sample of the data the model is shown and the steps
an expert would plan (clean, aggregate, pivot, join and so on). Each case
goes to your server the way Tableau Prep sends it: the request names the Prep
flow-plan intent and carries the sample data, the server builds Tableau
Prep's own prompt and asks the site's model, and the tool scores the plan
that comes back.

A run takes about ten minutes (ten to fifteen seconds per case).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Plan similarity | The planned steps match the expert's, in order | The plan reaches the result another way, or not at all; read the plan |
| Step recall | Every step the expert planned is in the plan, in any order | The model leaves steps out |
| Step precision | Every planned step was expected | The model adds steps the task does not need |

Where a request can be done more than one way (a fill-down calculation or
a New Rows step), the case lists the other plans as `acceptable-flow-plans`.
The plan closest to the model's is the one all three scores are read
against, and the explanations name it.

The tool shows one Flow plan quality score per run, colored against a
baseline of 80 agreed with the Tableau Prep team: green from 80, yellow
from 55 up to 80, red below 55. Open any case to see the plan next to the expert's and which steps are
missing or extra.
