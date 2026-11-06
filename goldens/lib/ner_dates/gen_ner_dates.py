#!/usr/bin/env python3
"""Generate expected.json for the ner_dates micro-golden.

Reference date/time entity extraction:
    spacy.load("en_core_web_trf")
    for ent in doc.ents:
        if ent.label_ in ["DATE", "TIME"] and ...

Golden = the DATE/TIME entity spans (text, char start/end, label) for each sentence.
We ALSO record all entities (any label) for context/debugging, but the DATE/TIME
subset is the authoritative golden the TS port must approximate.

Requires the en_core_web_trf model (installed in the scratch venv, loads offline).
Reads inputs.json, writes expected.json. Idempotent.

Run with HF/transformers offline to avoid any network attempt:
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 <venv>/bin/python gen_ner_dates.py
"""
import json
import os

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

import spacy

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL = "en_core_web_trf"
DATE_TIME_LABELS = ["DATE", "TIME"]


def main():
    with open(os.path.join(HERE, "inputs.json")) as f:
        inputs = json.load(f)

    nlp = spacy.load(MODEL)
    model_version = nlp.meta.get("version", "unknown")
    spacy_version = nlp.meta.get("spacy_version", spacy.__version__)

    out = {
        "_generated_by": "gen_ner_dates.py",
        "_library": f"spaCy {spacy.__version__}, model {MODEL} v{model_version} (spacy_version {spacy_version})",
        "_filter": "ent.label_ in ['DATE','TIME'] (matches is_date_related)",
        "sentences": [],
    }

    for s in inputs["sentences"]:
        doc = nlp(s["text"])
        all_ents = [
            {"text": e.text, "label": e.label_, "start_char": e.start_char, "end_char": e.end_char}
            for e in doc.ents
        ]
        date_time_ents = [e for e in all_ents if e["label"] in DATE_TIME_LABELS]
        out["sentences"].append(
            {
                "name": s["name"],
                "text": s["text"],
                "date_time_spans": date_time_ents,
                "all_entities": all_ents,
            }
        )

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.join(HERE, "expected.json"))


if __name__ == "__main__":
    main()
