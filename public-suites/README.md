# Test suites

A *suite* is a set of test cases for one Tableau AI capability. Each case has a
question a Tableau user might ask, the dataset it is about, and the answer the
AI should produce. When you run a suite, the tool sends every question to your
Tableau Server, collects the AI's answer, and scores it against the expected
one.

Everything in this directory uses publicly releasable data only. The
`fixtures/` folder holds every dataset the cases refer to, so a run never
touches your own data: the server's AI answers questions about these sample
datasets, not about your published content.

## What you can run

| Suite in the app | Tableau AI capability it exercises | Cases | Typical run time | Scoring |
|---|---|---|---|---|
| Calculated fields | Tableau Agent writing a calculated field | 166 | About 35 minutes | Deterministic; evaluator model optional |
| Color palettes | Tableau suggesting a color palette for a chart | 34 | About 3 minutes | Deterministic; evaluator model optional |
| Dashboard Narratives | Tableau Agent in Dashboards writing a dashboard narrative | 17 | About 5 minutes | Deterministic; evaluator model optional |
| Calculated fields in flows (Prep) | Tableau Prep writing a calculated field for a flow step | 43 | About 5 minutes | Deterministic; evaluator model optional |
| Plan a flow (Prep) | Tableau Prep planning the steps that clean and transform the data | 47 | About 10 minutes | Deterministic |
| Understand the request (Prep) | Tableau Prep recognizing what the user wants to do | 564 | About 30 minutes | Deterministic |
| Build a visualization | Tableau Agent building a visualization from a question | 1,160 | About 4 hours | Deterministic; evaluator model optional |

Run times are from the reference runs; an evaluator model adds a few seconds
per case for the suites that use one. Suites run one at a time, results
appear case by case, and you can pause, resume or cancel a run at any point.
Every suite needs Tableau Server 2026.4 or later.

"Deterministic" scoring compares the AI's answer with the expected answer by
rule (same fields, valid formula, and so on) and needs no extra setup. The
optional LLM-as-a-Judge / Evaluator model adds a second model's opinion on
free-text parts of an answer; the guide explains how to set it up.

The Color palettes suite uses no dataset; its cases are in
[color-palette/](color-palette/README.md) and the tool runs them on its own.
Dashboard Narratives ([dashboard-narratives/](dashboard-narratives/README.md))
carries everything the server needs inside each case: seventeen Tableau Public
dashboards with the outliers and insights Tableau detected in them. The three
Prep suites are in `prep/`, with their flows and step data in
[prep-bench/](../prep-bench/README.md), each with its own README
([calculated fields in flows](prep/calc-gen/README.md),
[plan a flow](prep/flow-plan-gen/README.md),
[understand the request](prep/intent-gen/README.md)).
A Questions about a dashboard suite (Tableau Agent in Dashboards answering a
question about a dashboard's data) is not part of this release; it is planned
for a later one. Each suite README is written for
the server administrator running it: what it needs, what it does, how to read
the scores, and the baseline it is compared with.

## Directory layout

| Directory | Contents |
|---|---|
| `vizgen/` | Viz Authoring cases (1,160 cases in 838 files) and their case-to-dataset mapping |
| `calcs/` | Calc Generation cases and mapping |
| `color-palette/` | Color Palettes cases (34); they refer to no dataset |
| `dashboard-narratives/` | Dashboard Narratives cases (17, one Tableau Public dashboard each) |
| `field-search/` | For the prompt-only runner: the dataset fields shown to the model for each case |
| `fixtures/` | One JSON file per dataset, in the evaluator's fixture format (fields, types, sample values) |
| `prep/` | The three Tableau Prep suites: `calc-gen/` (43 cases), `flow-plan-gen/` (47) and `intent-gen/` (564); the flows and step data they name are in `../prep-bench/` |

Each suite directory has its own README describing how the cases were
produced and reviewed.

## The datasets

The calculation and visualization cases ask about these sample datasets. The
suites carry a description of each (its fields, their types and a few sample
values, in `fixtures/`), which is what the server's AI sees; the rows
themselves are not shipped and are not needed for a run.

| Dataset | What it is | Fields |
|---|---|---|
| Retail NTO | Tableau's demo data for a fictional outdoor-gear retailer: one row per order line, with the product (brand, category, color), the customer's city and carrier, order and ship dates, and sales, quantity and profit measures | 57 |
| Data Depot: Account 360 | Tableau's fictional CRM demo data, one row per customer account: name, industry, type, address, number of employees, and the account's revenue and pipeline measures | 67 |
| Data Depot: Opportunity 360 | The same CRM, one row per sales opportunity: name, type, lead source, stage, amount, close date | 46 |
| Data Depot: Support 360 | The same CRM, one row per support case: subject, status, type, origin, priority, dates opened and closed | 43 |
| Data Depot: Activity 360 | The same CRM, one row per activity or task: subject, date, status, priority, type, start time | 37 |
| Data Depot: Retail 360 | The same CRM, one row per order line item: item, product, quantity, unit price, line total | 36 |
| [Chicago taxi trips 2024](https://data.cityofchicago.org/Transportation/Taxi-Trips-2024-/ajtu-isnz) | City of Chicago open data, one row per taxi trip: pickup and drop-off times, census tracts and coordinates, trip seconds and miles, fare, tips, extras and the taxi company | 26 |
| Streaming key metrics | Daily streaming metrics of a music service by country and age group: daily and monthly active users, content hours and related measures | 12 |
| [EdX 2013 courses](https://doi.org/10.7910/DVN/26147) | HarvardX and MITx course engagement (the Person-Course dataset), aggregated to one row per course, country and level of education: registrations, explorers, certificates, hours and events | 27 |
| [FEC 2016 expenditures](https://www.fec.gov/data/disbursements/) | U.S. Federal Election Commission presidential candidate expenditures (public domain), one row per disbursement: committee, candidate, party, recipient, purpose, amount, date | 22 |
| [IPEDS 2013 institutions](https://nces.ed.gov/ipeds/use-the-data) | U.S. Department of Education institution characteristics (public domain), one row per higher-education institution: name, location, control, highest degree offered, enrollment, tuition and completion measures | 148 |
