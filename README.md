# <img src="packages/frontend/public/logo512.png" width="48" alt="" align="absmiddle"> Tableau AI Model Evaluation Tool

Tableau Server's AI features, such as Tableau Agent building a visualization or
writing a calculated field, are powered by the large language model (LLM)
connected to each site under **Site Settings > AI in Tableau**. The Tableau AI
Model Evaluation Tool tells you how well that model does the job. It sends the
site's AI features a set of realistic test requests with known-good answers,
scores what comes back, and shows the scores in your browser. When a run is
done, you can export the results or publish them to your server as a data
source.

The tool is a single program that runs on your own computer. There is nothing to
install on the server.

Keep two things in mind:

- **The tool evaluates the model the site is configured to use.** It cannot
  choose a model and it changes no server setting. To compare two models, run
  the same test suite twice and change the model in Site Settings between runs.
- **Evaluations count as AI usage on your server**, under the account whose
  personal access token (PAT) you use. A test suite sends a few hundred to a few
  thousand requests, up to three at a time.

## Requirements

| | |
|---|---|
| **Tableau Server** | 2026.3 or later. An earlier server can still receive published results, but nothing can be evaluated against it. |
| **Site** | An LLM provider connected and valid model settings under **Site Settings > AI in Tableau** (see Step 1). |
| **Account** | A Tableau account on the site that can use the AI features you will evaluate. To publish results, it also needs permission to publish to the site. |
| **Computer** | macOS on Apple silicon, Windows on x64, or Linux on x64. Any laptop is enough: the server and the model do the work. To run from source instead of a release (Step 2), also [Bun](https://bun.sh) 1.4 or later and Git. |
| **Network** | Your computer must reach the server's web address (connect to the VPN first if the server is internal). Nothing needs to reach your computer. The first time you publish results, the tool also downloads the Tableau Hyper engine from `registry.npmjs.org`. |
| **Optional** | An API key from OpenAI, Anthropic, or Google, to score written answers with an evaluator model. No test suite requires one. |

## Step 1: Prepare your server

1. Sign in to the site as an administrator, open **Site Settings**, and scroll to
   **AI in Tableau**. Check the following:
   - **Connect to Large Language Model (LLM) Provider** reads *LLM provider
     connected*.
   - **Model Settings** reads *Model settings valid*. The tool evaluates the
     **Perform analytics tasks** model, the one the server uses to build
     visualizations and write calculations.
   - Under **AI Settings by Feature**, the features you want to evaluate read
     *Turned On*, with user access that includes the account you will use:
     - **Tableau Agent in Authoring**: the calculated field, visualization and
       color palette suites.
     - **Tableau Agent in Tableau Prep**: the Prep suites.
     - **Tableau Agent in Dashboards**: the Dashboard Narratives and Questions
       about a dashboard suites.

   > **Note:** A feature that is turned off is the most common reason a run fails
   > on every test case while the connection test passes.

2. Create a personal access token for the tool. Tableau's instructions are at
   [Personal Access Tokens](https://help.tableau.com/current/server/en-us/security_personal_access_tokens.htm).
   1. Sign in to the site you want to evaluate.
   2. Select your account icon > **My Account Settings**.
   3. Under **Personal Access Tokens**, enter a name such as `ai-model-eval` and
      select **Create Token**.
   4. Copy the secret now; it is shown only once. Note the token name exactly as
      Tableau displays it.
3. Note the **site name** from the address bar: the part after `#/site/`, for
   example `EvalTesting` in `https://tableau.example.com/#/site/EvalTesting/home`.
   It is case-sensitive. If the address has no `#/site/`, you are on the default
   site and the site name is blank.

> **Important:** Use the token only for this tool, on one computer. A token
> supports one session at a time: if the same token signs in anywhere else, the
> tool's session ends and a running evaluation starts failing.

## Step 2: Get and start the tool

There are two ways to get the tool. A **release ZIP** needs nothing else
installed. **From source** needs Bun and Git, and is the way to run a version
that has no release yet, such as a preview build for a bug bash.

### From a release ZIP

1. Download the ZIP file for your computer from the
   [Releases](https://github.com/tableau/tableau-ai-model-evaluation-tool/releases)
   page, or use the ZIP you were given:

   | Computer | File |
   |---|---|
   | Mac with Apple silicon | `tableau-ai-eval-v<version>-darwin-arm64.zip` |
   | Windows | `tableau-ai-eval-v<version>-windows-x64.zip` |
   | Linux | `tableau-ai-eval-v<version>-linux-x64.zip` |

2. Unzip it into a folder of your choice. The folder holds the program
   (`tableau-ai-eval`, or `tableau-ai-eval.exe` on Windows) and this README.
3. Allow the program to run (first time only). The program is not signed yet,
   so the operating system blocks it until you allow it.

   macOS: open a terminal in the folder and run

   ```sh
   xattr -d com.apple.quarantine ./tableau-ai-eval
   ```

   If you started the program first, macOS shows *"tableau-ai-eval" Not
   Opened*; close that dialog, run the command above, and start it again.

   Windows: when SmartScreen shows *Windows protected your PC*, select
   **More info** > **Run anyway**.

4. Open a terminal in that folder and start the tool.

   macOS or Linux:

   ```sh
   ./tableau-ai-eval serve
   ```

   Windows (PowerShell):

   ```powershell
   .\tableau-ai-eval.exe serve
   ```

   The tool prints `Tableau AI Model Evaluation Tool <version> listening on
   http://127.0.0.1:8000` and keeps running. Leave the terminal open.

5. Open **http://localhost:8000** in your browser.

### From source

1. Install [Bun](https://bun.sh) 1.4 or later (macOS or Linux:
   `curl -fsSL https://bun.sh/install | bash`; Windows, in PowerShell:
   `powershell -c "irm bun.sh/install.ps1 | iex"`) and
   [Git](https://git-scm.com/downloads). Open a new terminal afterwards so
   that `bun` is found.
2. Clone this repository using its GitHub **Code** button, or download and
   extract its source ZIP. In the resulting directory, start the tool.
   The first `bun install` also builds the
   browser UI and takes a few minutes:

   ```sh
   bun install
   bun start
   ```

   On Windows, run the same two lines in PowerShell. The tool prints
   `listening on http://127.0.0.1:8000` and keeps running. Leave the terminal
   open.
3. Open **http://localhost:8000** in your browser.

To build your own executable, or for development and tests, see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Whichever way you started it, the first time you open the tool a welcome
dialog offers short guided tours. **Take a Tour**, at the top right of every
page, opens it again.

To stop the tool, press Ctrl+C in the terminal. An evaluation keeps running if
you close the browser tab, but not if you stop the tool. A run that was
interrupted that way is paused the next time the tool starts, and you can resume
it from its results page.

## Step 3: Connect the tool to your server

The home page opens with an **Evaluation Setup** panel of three steps.

1. On **Connect Your Server**, select **Start** and enter:

   | Field | What to enter |
   |---|---|
   | Tableau Server URL | The address you use in the browser, for example `https://tableau.example.com`, with nothing after the host name |
   | Site name | The site name from Step 1. Leave it blank for the default site. |
   | PAT name and secret | The token from Step 1 |

2. Select **Test and Save Connection**. The tool runs three checks and saves the
   connection when all three pass:

   | Check | What it confirms | If it fails |
   |---|---|---|
   | Server reachable | The address answers and this computer trusts its certificate | Check the address and the VPN. For a certificate error, see [Troubleshooting](#troubleshooting). |
   | PAT sign-in | The token signs in to that site | Check the token name, the secret, and the site name, including its capitalization |
   | AI endpoint | The site's model answers one request through the server | A problem with the server's AI setup, not with the tool. See [Troubleshooting](#troubleshooting). |

   When the connection is saved, the card shows the server, the site, and the
   **evaluated model**, which the tool reads from Site Settings.

3. Optional: on **Select Evaluator Model**, select **Start**, choose a provider
   (OpenAI, Anthropic, or Gemini) and model, enter your API key, and select
   **Save**. The evaluator model grades written answers, such as whether a
   dashboard summary is grounded in the data. Choose a model from a different
   family than the evaluated model, so a model never grades its own family.
   Calls to it are billed to your provider account, roughly one per test case.
   Without an evaluator model, every suite still runs and the scores that need
   one are left out.

## Step 4: Run your first evaluation

1. Select the **Evaluate AI in Tableau Features** tab on the home page.
2. Open the **Tableau Agent in Authoring** card and select **Calculated fields**.
3. On the page that opens, select **Evaluate**.

Calculated fields is a good first run: 166 test cases, about 35 minutes. Results
appear case by case, and you can pause, resume, or cancel the run from its
results page. Past runs are in the **Evaluation History** tab.

> **Note:** **Evaluate** on a feature card runs every suite of that feature, one
> after another, which can take many hours. Hover over it first to see the
> suites, their sizes, and how long each takes.

| Suite | AI feature | Test cases | Typical run time |
|---|---|---|---|
| Calculated fields | Tableau Agent in Authoring | 166 | About 35 minutes |
| Color palettes | Tableau Agent in Authoring | 34 | About 3 minutes |
| Build a visualization | Tableau Agent in Authoring | 1,160 | About 4 hours |
| Calculated fields in flows | Tableau Agent in Tableau Prep | 43 | About 5 minutes |
| Plan a flow | Tableau Agent in Tableau Prep | 47 | About 10 minutes |
| Understand the request | Tableau Agent in Tableau Prep | 564 | About 30 minutes |
| Dashboard Narratives | Tableau Agent in Dashboards | 17 | About 5 minutes |

[public-suites/README.md](public-suites/README.md) describes each suite and the
public data sets it uses.

> **Important:** Do not change the site's AI settings while a run is in progress.
> The server would answer the remaining test cases with the new model, and the
> run would mix two models under one name.

## Step 5: Read, export, and publish the results

- **Scores** run from 0 to 100 percent. On the home page, the color of a score
  compares it with a baseline, the score Tableau's default model reached on the
  same suite: green is at or above the baseline, yellow is a little lower, and
  red is much lower.
- **Each test case** shows the request, the expected answer, what the AI
  produced, and each metric's score with an explanation. Hover over a metric
  name to see what it checks.
- **Unavailable** on an evaluator score means the call to the evaluator model
  failed for that case. Unavailable scores are left out of averages.
- **Error** rows are test cases the server could not answer. The message says
  why, for example that an AI feature is turned off for your account.

A language model does not give the same answer twice, so two runs of the same
suite differ by a few points. Before comparing two models, run the suite at least
three times with each and compare the averages.

To keep a run, use the two buttons at the top right of its results page.
**Download results** (the download arrow) saves it as a CSV or JSON file.
**Publish to your Tableau Server** (the upload arrow) adds it to a data source
named **AI Model Evaluation Results** in a project named **AI Model Evaluations**
on your site. Every
published run is added to the same data source, so one workbook can chart all
your evaluations over time. [docs/EXPORT_COLUMNS.md](docs/EXPORT_COLUMNS.md)
explains every column.

## Update the tool

1. Stop the tool with Ctrl+C.
2. From a release ZIP: download the new ZIP file and unzip it over the old
   folder, or into a new one. From source: run `git pull` and then
   `bun install` in the tool's folder.
3. Start the tool again as in Step 2.

Your connection, settings and results are kept: they are stored outside the
program's folder (see [Where the tool keeps its data](#where-the-tool-keeps-its-data)).

## Configuration

Every setting has a working default. Options go after `serve`, for example
`./tableau-ai-eval serve --port 8100`:

| Option | Purpose |
|---|---|
| `--port <number>` | Listen on another port, if 8000 is taken |
| `--allow-self-signed` | Show the **Verify TLS certificate** switch in the connection form. Use it only as a last resort (see [Troubleshooting](#troubleshooting)). |

Environment variables, set in the terminal before you start the tool:

| Variable | Purpose | Default |
|---|---|---|
| `TABLEAU_AI_EVAL_PORT` | Port the tool listens on | `8000` |
| `TABLEAU_AI_EVAL_DATA_DIR` | Folder for settings and results | `~/.tableau-ai-eval` |
| `TABLEAU_AI_EVAL_CA_BUNDLE` | A certificate file (PEM) to trust in addition to this computer's | `~/.tableau-ai-eval/ca.pem`, when it exists |
| `TABLEAU_AI_EVAL_MAX_CONCURRENCY` | How many test cases a run works on at once. `1` runs them one after another, if your model's provider limits request rates. | `3` |
| `TABLEAU_AI_EVAL_REQUEST_TIMEOUT` | Seconds the tool waits for the server to answer one request before trying again (three attempts in all). Raise it if your model's gateway is slow. | `120` |

Other commands:

| Command | What it does |
|---|---|
| `tableau-ai-eval trust <server-url>` | Saves your server's certificate so the tool trusts it (see [Troubleshooting](#troubleshooting)) |
| `tableau-ai-eval version` | Prints the version |

### Security

The tool has no sign-in of its own, so it accepts connections only from your
own computer (`127.0.0.1`). Keep it that way: do not expose it on a network
address, put it behind a proxy, or run it on a shared computer. Anyone who can
reach it can start evaluations with your token.

### Where the tool keeps its data

- **Settings, run history and results**: `~/.tableau-ai-eval/nlq_eval_results.db`
  (Windows: `C:\Users\<you>\.tableau-ai-eval\nlq_eval_results.db`). The file also
  holds your token secret and evaluator API key, so they can be reused between
  runs. They are masked in the browser and left out of exports. Treat the folder
  as a credential store and revoke the token when you stop using the tool.
  Deleting the file resets the tool. When you run from source, this file is
  `packages/server/data/nlq_eval_results.db` inside the tool's folder instead.
- **Certificate file**, if you created one: `~/.tableau-ai-eval/ca.pem`.
- **Tableau Hyper engine**, downloaded the first time you publish:
  `~/.tableau-ai-eval/bin/`.
- **On your server**: only what you publish, in the **AI Model Evaluations**
  project.

## Troubleshooting

### Starting the tool

- **Running the program prints a list of commands and exits.** Add `serve`:
  `./tableau-ai-eval serve`.
- **"Address already in use" or "port 8000 is in use".** Another program holds
  port 8000. Start the tool on another port, for example
  `./tableau-ai-eval serve --port 8100`, and open `http://localhost:8100`.
- **Linux, "Permission denied".** Run `chmod +x tableau-ai-eval` in the folder.
- **macOS says the developer cannot be verified, or Windows shows SmartScreen.**
  See the note in [Step 2](#step-2-get-and-start-the-tool).
- **From source, `bun start` fails or the page looks old after a `git pull`.**
  Run `bun install` again; it rebuilds the browser UI. Then `bun start`.

### Connection

- **Server reachable fails with *This computer does not trust the
  certificate*.** Your server's certificate comes from an authority this
  computer does not trust, which is common for on-premises servers. Open the
  server's address in a browser on the same computer. If the browser warns too,
  ask your IT team to install the authority's certificate on this computer.
  Otherwise, save the server's certificate for the tool:

  ```sh
  ./tableau-ai-eval trust https://tableau.example.com
  ```

  It writes `~/.tableau-ai-eval/ca.pem`. Restart the tool and select **Test and
  Save Connection** again. If the command warns that it captured only one
  certificate, ask your Tableau Server administrator for the certificate
  authority's certificate file and set `TABLEAU_AI_EVAL_CA_BUNDLE` to its path.
  As a last resort for a test server you trust, start the tool with
  `--allow-self-signed` and turn off **Verify TLS certificate** in the
  connection form.
- **PAT sign-in fails.** Check the token name (as Tableau displays it), the
  secret, and the site name, including its capitalization. Tokens expire when
  they are not used for a while, and a token that signed in somewhere else ends
  the tool's session: create a new one.
- **The result reads *Connected, server too old*.** The server is earlier than
  2026.3. The connection is saved so you can publish results to it, but every
  suite is disabled. Upgrade the server, then select **Test Again** on the first
  card.
- **AI endpoint fails with *does not enable the AI endpoint*.** The
  server build does not include the endpoint the tool needs. This is not a site
  setting; confirm the server version with your Tableau contact.
- **AI endpoint fails with an HTTP 500 error.** The site's model is not
  configured, or its provider returned an error. Check **Site Settings > AI in
  Tableau** and try again; a single 500 is usually the provider.
- **The connection test says an evaluation is running with the token.** Testing
  signs in with the token, which would end the running evaluation's session.
  Pause the evaluation first, or test with another token.

### Runs

- **Every test case fails within seconds with a 403 error while the connection
  test passes.** The AI feature is turned off for your account. In **Site
  Settings > AI in Tableau > AI Settings by Feature**, the feature must read
  *Turned On* with user access that includes you.
- **The run pauses after several test cases fail with a 401 error.** Another
  sign-in with the same token ended the tool's session. Create a token that only
  this tool uses, save it in **Connect Your Server**, and resume the run.
- **A run is much slower than the estimate.** The model's provider is slow or
  limiting requests. The tool retries a few times per test case and once more at
  the end of the run. Start the tool with `TABLEAU_AI_EVAL_MAX_CONCURRENCY=1` to
  send one request at a time.
- **Evaluator scores read *Unavailable*.** The call to the evaluator model
  failed, usually a wrong API key or a rate limit. Other scores are not affected.

### Publishing

- **Publishing fails while downloading Tableau Hyper.** The first publish
  downloads the Hyper engine from `registry.npmjs.org`. Allow that address, or
  configure your proxy, and try again. Downloading results as CSV or JSON works
  without it.
- **Publishing stops because a data source of that name already exists.** It
  was made by an earlier version of the tool with different columns. Rename or
  delete the **AI Model Evaluation Results** data source on the server, then
  publish again.

## Get help

To report a problem, open an issue on the
[GitHub Issues](https://github.com/tableau/tableau-ai-model-evaluation-tool/issues)
page. Include the first lines the tool printed when it started and, for a
problem with a run, the run's exported JSON file.

- [CONTRIBUTING.md](CONTRIBUTING.md): how to propose changes. The Salesforce CLA
  is required.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): the Salesforce open source code of
  conduct.
- [SECURITY.md](SECURITY.md): how to report a vulnerability.

## License

Apache-2.0. See [LICENSE.txt](LICENSE.txt).
