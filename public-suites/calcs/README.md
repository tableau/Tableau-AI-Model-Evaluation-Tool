# Calculated fields suite

This suite tells a server administrator how well the site's configured AI
model writes Tableau calculations: the formula a user gets when they describe
a calculated field to Tableau Agent in Authoring. Run it before turning the
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

166 cases, each a request in words ("profit as a share of sales", "the number
of days between order and ship date") about one of eight public sample
datasets, with the formula an expert wrote. The tool registers the dataset's
description with your server, sends the request, and scores the formula the
site's model returns. A run takes about 35 minutes (eight to ten seconds per
case; the judge adds a few more). The datasets are listed in
[../README.md](../README.md).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Calculation validity | The formula parses as Tableau's calculation language, uses only Tableau functions, and refers only to fields the dataset has | Formulas users would have to fix by hand |
| Formula field validity | Every field the formula names exists in the dataset | The model invents field names |
| Field precision / recall | The formula uses the fields the expert's formula uses, and no others | Wrong or missing fields: the calculation answers a different question |
| Value precision / recall | The literal values in the formula (numbers, text) are the expert's | Invented constants, or a threshold the request named left out |
| Intent match | The model recognised the request as a calculation | Requests routed to the wrong feature |
| Coherence, Factual grounding (judge) | The explanation the model gives with the formula is clear and describes what the formula does | Explanations users cannot rely on |

The tool shows one Calculated fields score per run (the deterministic checks;
the judge's scores are shown beside it and do not count in it) against the
baseline the tool shows; open any case to see the formula next to the expert's, the
fields the server offered the model, and the reason for each score. Two of
the checks compare the formula with the expert's *text*, so a correct formula
written another way scores below 1 on them; read the formula before calling
it wrong.
