#!/usr/bin/env python3
"""Generate expected.json for the tfidf_cosine micro-golden.

Reference conciseness scoring operations:

    vectorizer = TfidfVectorizer().fit_transform(filtered_sentences)
    similarity_matrix = cosine_similarity(vectorizer, vectorizer)

Uses DEFAULT TfidfVectorizer params (that is exactly what the reference code does).
Reads inputs.json, writes expected.json. Idempotent.

Run with the scratch venv python:
    python gen_tfidf_cosine.py
"""
import json
import os

import numpy as np
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND = 10  # decimals; see README tolerance guidance


def compute_matrix(sentences):
    m = TfidfVectorizer().fit_transform(sentences)
    sim = cosine_similarity(m, m)
    return np.round(sim, ROUND).tolist()


def main():
    with open(os.path.join(HERE, "inputs.json")) as f:
        inputs = json.load(f)

    out = {
        "_generated_by": "gen_tfidf_cosine.py",
        "_rounding_decimals": ROUND,
        "_library": "scikit-learn (TfidfVectorizer + cosine_similarity), default params",
        "cases": [],
    }
    for case in inputs["cases"]:
        matrix = compute_matrix(case["sentences"])
        out["cases"].append(
            {
                "name": case["name"],
                "cosine_similarity_matrix": matrix,
            }
        )

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.join(HERE, "expected.json"))


if __name__ == "__main__":
    main()
