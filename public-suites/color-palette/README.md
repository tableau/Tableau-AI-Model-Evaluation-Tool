# Color palettes suite

This suite tells a server administrator how well the site's configured AI
model suggests color palettes: the colors a Tableau user gets when they ask
Tableau Agent for "ocean colors" or "a palette for profit and loss". Run it
before turning the feature on for your users, or after changing the site's
model, and read the score against the baseline the tool shows.

## What you need

- **Tableau Server 2026.4 or later.** The suite calls the server's palette
  endpoint, which earlier releases do not have; the tool's connection test
  says *server too old* on such a release and keeps every suite disabled.
- **Tableau Agent in Authoring turned on** for the site and for the account
  whose Personal Access Token the tool uses: Site Settings → AI in Tableau.
  When palette generation is off, every case fails with a message saying so.
- **An evaluator model** (Settings → Evaluator model) if you want the three
  judged scores: valid format, relevance to the request and design quality.
  Without one the deterministic checks still run.
- Nothing on your site: the cases refer to no data.

## What the suite does

34 cases, one short request each, of the three kinds a user can ask for:

| Palette type | Cases | What it is for |
|---|---|---|
| `regular` | 16 | Distinct colors for categories |
| `sequential` | 11 | An ordered progression, for values from low to high |
| `diverging` | 7 | Two contrasting ends around a neutral middle |

The tool sends each request and its palette type to the server; the site's
model answers with a list of colors; the tool scores them. A run takes about
three minutes (two to four seconds per palette).

## How to read the scores

| Score | What a high score means | What a low score tells you |
|---|---|---|
| Distinguishability (regular palettes) | Every pair of colors is far enough apart to tell two categories apart | Two categories would look alike on a chart |
| Gradient smoothness (sequential, diverging) | The steps from one color to the next are even | The scale has jumps, so equal differences in the data look unequal |
| Diverging structure (diverging) | The two ends differ clearly and the middle differs from both | The palette does not read as "below, neutral, above" |
| Ground truth match (6 cases with a known answer) | The colors are close to the expected ones ("American flag colors" came back red, white and blue) | The model ignores a request with one right answer |
| Valid format (judge) | Every color is a well-formed hex code in the structure the palette type calls for | The palette cannot be used as returned |
| Relevance (judge) | The palette fits what was asked for | "Ocean colors" came back in browns |
| Design (judge) | Sound color theory and accessibility | Clashing or hard-to-read combinations |

Color difference is measured as CIEDE2000 Delta E, the standard measure of
how different two colors look. The tool shows one Palette quality score per
run against the baseline it carries; open any case to see the colors next to
the request and the reason for each score.

## How a case runs and is scored

The tool posts the request and the palette type to the server's palette
endpoint (`color-palettes/generate`) with the run's session; the server
answers with a list of hex colors from the model the site is configured to use
(**Perform analytics tasks** in Site Settings → AI in Tableau → Model
Settings). The deterministic checks are computed by the tool from the colors
alone (`backend/palette_metrics.py`, a port of the evaluator's four palette
metrics with a parity fixture). Six cases name a specific answer and carry it
as `expected.colorPalette`; the other 28 have no single right palette, so
their expected list is empty and they are scored on the checks and the
judge's three ratings.

## Case format

```json
{
    "runner": "color-palettes-server",
    "info": { "version": "1.0.0" },
    "inputs": [
        {
            "utterance": "American flag colors",
            "source": "user",
            "arguments": { "palette_type": "regular" },
            "expected": { "colorPalette": ["#FF0000", "#FFFFFF", "#0000FF"] },
            "tags": ["color-palette-regular"]
        }
    ],
    "id": "cb892058-5b9d-4188-9001-1edd31411375"
}
```
