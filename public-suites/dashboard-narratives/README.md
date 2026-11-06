# Dashboard Narratives suite

This suite tells a server administrator how well the site's configured AI
model writes dashboard narratives: the text a viewer gets when they ask
Tableau Agent in Dashboards to summarise a dashboard. Run it before turning
the feature on for your users, or after changing the site's model, and read
the scores against the baseline the tool shows.

## What you need

- **Tableau Server 2026.4 or later.** The suite calls the server's dashboard
  insights endpoint, which earlier releases do not have; the tool's connection
  test says *server too old* on such a release and keeps every suite disabled.
- **Dashboard Narratives turned on** for the site, and for the account whose
  Personal Access Token the tool uses: Site Settings → AI in Tableau → *Tableau
  Agent in Dashboards*. When it is off, every case fails with a message saying
  so.
- **An evaluator model** (Settings → Evaluator model) if you want the two
  judge scores, similarity to the reference summary and semantic factuality.
  Without one the deterministic scores still run.
- Nothing on your site: the cases carry everything the server needs. The
  dashboards are **not** published to your site and no data leaves the
  request.

## What the suite does

Seventeen cases, one public dashboard each (listed below). A case is exactly
what a dashboard sends to the server when a viewer asks for a summary: the
picture of the dashboard, the list of its views, and the outliers and Pulse
insights Tableau detected in those views. The tool posts that request to your
server; your site's model writes the summary; the tool scores it. One run
takes a few minutes (the model's own time per summary, 5 to 30 seconds each).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Outliers recall, Insights recall | The summary mentions the figures Tableau flagged (the outliers and Pulse insights) | The model skips what the dashboard itself considers notable |
| Numerical precision | The figures in the summary come from the dashboard | The model is inventing or mis-reading numbers; viewers cannot trust the figures |
| Semantic factuality (judge) | Each figure is described the right way round (a high value called high, a fall called a fall) | Figures are right but the story around them is wrong |
| Similarity to the reference (judge) | The narrative conveys the key insights of a person's reference narrative of the same dashboard (rated 0 to 10, shown as 0 to 1) | The narrative misses most of what the dashboard is about |
| Readability | The prose is plain English (Flesch Reading Ease, figures left out) | Long, dense sentences |
| Conciseness | The summary does not repeat itself | Padding and restated points |

The tool shows one Narrative quality score per run and the baseline Tableau's
default model reached on the same cases. Green means the model does the job
at least as well as the default. Open any case to read the model's summary
next to the reference summary and the per-score explanations, which name the
missing or invented figures and the offending sections.

## The dashboards

Every case is a dashboard published on Tableau Public. 

| Case (`dashboardName`) | Dashboard on Tableau Public | 
|---|---|
| COVID-19 Global View | [Global COVID-19 Tracker (COVID-19 Data Resource Hub)](https://public.tableau.com/app/profile/covid.19.data.resource.hub/viz/COVID-19Cases_15840488375320/COVID-19GlobalView) |
| Expenses Audit | [Expenses Audit Dashboard (Luke Donovan)](https://public.tableau.com/app/profile/luke.donovan/viz/ExpensesAuditDashboard/ExpensesAudit) |
| NHS Hospital Admitted Patient Care | [NHS Hospital Admitted Patient Care Activity (Pradeepkumar G)](https://public.tableau.com/app/profile/pradeepkumar.g/viz/NHSHospitalAdmittedPatientCareActivity/viz) |
| HLS Patient record | [HEALTHCARE - Patient Record, a Tableau accelerator](https://public.tableau.com/app/profile/lintao/viz/PatientRecordDashboardW/Home) |
| Supply Chain | [RWFD Supply Chain Dashboard (Chimdi Nwosu)](https://public.tableau.com/app/profile/chimdi.nwosu/viz/RWFDSupplyChainDashboard/Overview) |
| Website Traffic Overview | [Website Traffic (Google Analytics) accelerator redesign (zainab2225)](https://public.tableau.com/app/profile/zainab2225/viz/WebsiteTrafficGoogleAnalyticsAcceleratorRedesign/WebsiteTrafficOverview) |
| Alliance Page | [Airline Alliance Activity Dashboard (Stephanie N. Anyama)](https://public.tableau.com/app/profile/neto.anyama/viz/AirlineAllianceActivityDashboard/AlliancePage) |
| Airlines Page | [Airline Alliance Activity Dashboard (Stephanie N. Anyama)](https://public.tableau.com/app/profile/neto.anyama/viz/AirlineAllianceActivityDashboard/AirlinesPage) |
| main page | [Urban Audit city factsheets 2019 (European Environment Agency)](https://public.tableau.com/app/profile/european.environment.agency/viz/test_20190116Urban_vulnerability_ideasFR_0/mainpage) |
| Employee Churn | [HUMAN RESOURCES - HR Workforce, a Tableau accelerator](https://public.tableau.com/app/profile/lintao/viz/HumanResources-HeadcountDashboard/EmployeeChurn) |
| Executive Summary | [HUMAN RESOURCES - HR Headcount, a Tableau accelerator](https://public.tableau.com/app/profile/lintao/viz/HRHeadcountDashboardadvanced/ExecutiveSummary) |
| Correlation Dashboard | [Satisfied-with-Surveys, a Tableau showcase](https://public.tableau.com/app/profile/technical.product.marketing/viz/Satisfied-with-Surveys_10_0/CorrelationDashboard) |
| Commission Model | [Sales Commission Model (Tableau for Sales Analytics)](https://public.tableau.com/app/profile/tableau.for.sales.analytics/viz/SalesCommissionModel_10_0_2/CommissionModel) |
| Profitability KPI | [Shipping Industry Example, a Tableau showcase](https://public.tableau.com/app/profile/technical.product.marketing/viz/ShippingIndustryExample_10_0/ProfitabilityKPI) |
| US_View | [Tax: US Sales by State (Tableau for Finance)](https://public.tableau.com/app/profile/tableau.for.finance/viz/TaxUSSalesbyState/US_View) |
| Dashboard | [Telecommunications, a Tableau showcase (Ross Perez)](https://public.tableau.com/app/profile/rosstest/viz/Telecommunications_2/Dashboard) |
| Dashboard 1 | [Boston Marathon Data Explorer (Brian Rock)](https://public.tableau.com/app/profile/brian.rock2158/viz/BostonMarathonDataExplorer/Dashboard1) |

A case is named after the dashboard sheet as Tableau sends it (`dashboardName`),
which is why three cases are called "main page", "Dashboard" and "Dashboard 1";
`info.title` carries the name the tool shows and `info.source_url` the address
the results page embeds the live dashboard from.

## Case format

```json
{
    "runner": "dashboard-viz-narrative-config",
    "tags": [],
    "info": {
        "source": "Tableau Public",
        "source_url": "https://public.tableau.com/views/GlobalCOVID-19Tracker/Overview"
    },
    "inputs": [
        {
            "arguments": {
                "dashboardName": "Global COVID-19 Tracker",
                "dashboardId": "GlobalCOVID-19Tracker",
                "views": [
                    {
                        "name": "New Positive Cases",
                        "datasourceLuid": "...",
                        "artifacts": [
                            { "artifactType": "OUTLIERS", "artifact": "..." },
                            { "artifactType": "PULSE_INSIGHTS", "artifact": "..." }
                        ]
                    }
                ],
                "dashboardArtifacts": [
                    { "artifactType": "IMAGE", "artifact": "<base64 PNG>" }
                ]
            },
            "expected": { "insightNarrative": "This dashboard provides ..." }
        }
    ],
    "id": "..."
}
```
