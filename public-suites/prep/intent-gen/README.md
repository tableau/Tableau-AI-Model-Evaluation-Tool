# Understand the request (Tableau Prep) suite

This suite tells a server administrator how reliably the site's configured AI
model recognises what a Tableau Prep user is asking for: whether a request is
for a calculation, a flow plan, or something else. Everything Tableau Agent in
Tableau Prep does next depends on this first decision. Run it before turning
the feature on for your users, or after changing the site's model, and read
the score against the baseline the tool shows.

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

564 cases, each a user request, five of them with the earlier turn of the
conversation, and the kind of request it is. Each case goes to your server
the way Tableau Prep sends it: the request names the Prep intent-detection
intent and carries the conversation so far, the server builds Tableau Prep's
own prompt and asks the site's model, and the tool compares the answer with
the expected kind.

A run takes about half an hour (one to two seconds per case).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Intent match | The model names the expected kind of request (letter case, quotes and punctuation around the word do not count) | Users would be routed to the wrong feature; even a few percent matters at this volume |

Thirteen requests can fairly be read two ways ("Help me find profits by
region" is a calculation, or an aggregate step in a flow). Those cases list
the second reading as `plausible-intents`, and a model that answers it gets
half credit; the case's explanation says so.

The tool shows one Intent and spec score per run, colored against a baseline
of 95 agreed with the Tableau Prep team: green from 95, yellow from 70 up to 95,
red below 70. Open any case to
see the request, the expected kind and the model's answer.
