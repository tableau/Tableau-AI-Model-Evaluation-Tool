# Regression fixtures and public library references

The committed fixtures under `goldens/` pin scoring, parsing, request, export,
and rendering behavior. Tests replay them offline; no Python checkout, Tableau
Server, model credentials, or private repository is required.

## Fixture groups

| Directory | Coverage |
|---|---|
| `agent/`, `metrics/`, `context_metrics/` | Calculation and visualization scoring |
| `narrative/` | Narrative metrics, requests, and judge parsing |
| `cabu/`, `request_shapes/` | Dashboard Q&A rendering and request contracts |
| `color-palette/`, `e2e/` | Recorded responses and deterministic scoring replay |
| `prep/`, `validator/` | Calculation validity and Prep scoring |
| `viz/` | Chart similarity, fields, filters, and presentation |
| `publish/`, `metric_catalog/` | Export bytes, Hyper rows, and score aggregation |
| `lib/` | Public Python library reference outputs |

Historical reference outputs are retained as regression data. Generators that
depended on unavailable source code are not distributed. Do not replace those
outputs with results from the implementation under test: that would erase the
independent regression check. Update a fixture only after reviewing the intended
behavior change, and update its tests alongside it.

## Public library generators

`goldens/lib/` retains self-contained Python generators and package-version
information. They use these publicly available projects:

- [scikit-learn](https://github.com/scikit-learn/scikit-learn): TF-IDF and cosine similarity
- [ranx](https://github.com/AmenRa/ranx): information-retrieval metrics
- [Colour](https://github.com/colour-science/colour): CIEDE2000 and color conversion
- [RapidFuzz](https://github.com/rapidfuzz/RapidFuzz): fuzzy string ratios
- [py-readability-metrics](https://github.com/cdimascio/py-readability-metrics)
  and [NLTK](https://github.com/nltk/nltk): readability primitives
- [spaCy](https://github.com/explosion/spaCy): date/time entity reference spans

See [the library fixture guide](../goldens/lib/README.md) for regeneration and
tolerances. The application uses dependency-free date detection, not the spaCy
model; those entity spans are comparative reference data, not an exact-output gate.

Run the complete offline regression suite with `bun test`.
