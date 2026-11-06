# Public-library reference fixtures

These small, offline reference tables check TypeScript scoring primitives against
public Python libraries. Each directory contains `inputs.json`, `expected.json`,
and a self-contained `gen_*.py` generator. No private source checkout is needed.
Public project links are in [the fixture guide](../../docs/GOLDENS.md).

## Regeneration

Use Python 3.11 in an isolated environment:

```sh
python3 -m venv .scratch/golden-venv
.scratch/golden-venv/bin/pip install scikit-learn ranx colour-science rapidfuzz py-readability-metrics nltk spacy
.scratch/golden-venv/bin/python goldens/lib/tfidf_cosine/gen_tfidf_cosine.py
.scratch/golden-venv/bin/python goldens/lib/ranx_ir/gen_ranx_ir.py
.scratch/golden-venv/bin/python goldens/lib/ciede2000/gen_ciede2000.py
.scratch/golden-venv/bin/python goldens/lib/fuzzy_ratios/gen_fuzzy_ratios.py
.scratch/golden-venv/bin/python goldens/lib/flesch/gen_flesch.py
```

For spaCy reference spans, install the model first:

```sh
.scratch/golden-venv/bin/python -m spacy download en_core_web_trf
HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 .scratch/golden-venv/bin/python goldens/lib/ner_dates/gen_ner_dates.py
```

Review changes before replacing committed reference outputs. Package upgrades may
change behavior. Versions used for the existing fixtures:

| Primitive | Package | Version |
|---|---|---|
| TF-IDF cosine | scikit-learn | 1.9.1 |
| Ranking | ranx | 0.3.21 |
| Color difference | colour-science | 0.4.7 |
| Fuzzy ratios | rapidfuzz | 3.14.6 |
| Readability | py-readability-metrics / nltk | 1.4.5 / 3.10.3 |
| Date entities | spaCy / en_core_web_trf | 3.8.16 / 3.8.0 |
| Supporting math | numpy / scipy | 2.4.6 / 1.17.1 |

## Interpretation and tolerances

- **TF-IDF:** default `TfidfVectorizer`, L2 normalization, smoothed IDF, and
  two-or-more-character word tokens; cosine matrices use 10-decimal rounding.
  Compare within `1e-9`, including Unicode and disjoint-token cases.
- **Ranking:** precision, recall, MAP, MRR, and hit-rate. Compare floating scores
  within `1e-9` and binary hit rates exactly. Equal-score tie ordering is captured
  explicitly. Empty rankings short-circuit rather than constructing a ranx Run.
- **CIEDE2000:** sRGB → XYZ → Lab with Colour's default illuminants and matrices.
  Compare color differences within `1e-6`; palette thresholds use a minimum
  pairwise distance of 10 and clamp `minimum / threshold` to `[0, 1]`.
- **Fuzzy ratios:** lowercased inputs, with the first input stripped; token-set
  and partial ratios use RapidFuzz's Indel similarity, not generic Levenshtein
  distance. Do not collapse internal whitespace. Compare within `1e-6`.
- **Readability:** the fixture uses TweetTokenizer, the library syllable counter,
  and explicit manual sentence counts, avoiding the optional `punkt_tab` resource.
  The formula is `206.835 - 1.015*(words/sentences) - 84.6*(syllables/words)`;
  normalized scores round to four decimals. Word and syllable counts are exact.
- **Date entities:** spaCy DATE/TIME spans are comparative references. The
  application uses dependency-free detection, so compare label membership and
  overlapping spans, not exact model offsets. Money and plain numbers are not
  date/time entities.
