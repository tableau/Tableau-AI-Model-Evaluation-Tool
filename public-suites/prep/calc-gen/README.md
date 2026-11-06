# Calculated fields in flows (Tableau Prep) suite

This suite tells a server administrator how well the site's configured AI
model writes calculated fields for Tableau Prep flows: the formula a user gets
when they describe a calculation in a flow step. Run it before turning Tableau
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
- **An evaluator model** (Settings → Evaluator model) if you want the two
  judged scores on the formula's explanation (coherence and factual
  grounding). Without one the deterministic checks still run.

## What the suite does

43 cases, each a request for a calculation in a named flow ("the number of
days between order and ship date", "profit as a share of sales") with the
fields of the flow's input and the formula an expert wrote. Each case goes
to your server the way Tableau Prep sends it: the request names the Prep
calculation intent and carries the flow's fields, the server builds Tableau
Prep's own prompt and asks the site's model, and the tool scores the formula
that comes back.

A run takes about five minutes (three to four seconds per case).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Calculation validity | The formula parses as Tableau's calculation language, uses only functions Tableau Prep has, and refers only to fields the flow has | Formulas users would have to fix by hand, or that refer to fields that do not exist |
| Formula similarity | The formula matches the expert's, or the closest of the case's accepted alternatives, token by token and in order (letter case, spacing and comments do not count) | The model solves the request a different way; read the formula before judging it wrong |

Where a request has more than one fair reading, or where another formula
gives the same result (`ZN([Sales])` and `IFNULL([Sales], 0)`), the case
lists those formulas as `acceptable-calcs`. The one closest to the model's
formula is the one scored against, and the explanation names it.
| Coherence, Factual grounding (judge) | The explanation the model gives with the formula is clear and describes what the formula does | Explanations users cannot rely on |

The tool shows one Calculated fields score per run (validity and similarity),
colored against a baseline of 85 agreed with the Tableau Prep team: green
from 85, yellow from 60 up to 85, red below 60. Open any case to see the formula next to the
expert's, the flow's fields, and the reason for each score.
