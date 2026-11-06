#!/usr/bin/env python3
"""Generate expected.json for the fuzzy_ratios micro-golden.

Reference operations for sentence relevance:

    fuzz.token_set_ratio(phrase.strip().lower(), sentence.lower())
    fuzz.partial_ratio(phrase.strip().lower(), sentence.lower())

So we apply .strip().lower() to 'a' and .lower() to 'b', matching the code.
rapidfuzz returns floats in [0, 100].

Reads inputs.json, writes expected.json. Idempotent.
"""
import json
import os

from rapidfuzz import fuzz

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND = 10


def main():
    with open(os.path.join(HERE, "inputs.json")) as f:
        inputs = json.load(f)

    out = {
        "_generated_by": "gen_fuzzy_ratios.py",
        "_rounding_decimals": ROUND,
        "_library": "rapidfuzz (fuzz.token_set_ratio, fuzz.partial_ratio)",
        "_preprocessing": "a -> a.strip().lower(); b -> b.lower() (matches reference code)",
        "pairs": [],
    }
    for pair in inputs["pairs"]:
        a = pair["a"].strip().lower()
        b = pair["b"].lower()
        out["pairs"].append(
            {
                "name": pair["name"],
                "token_set_ratio": round(float(fuzz.token_set_ratio(a, b)), ROUND),
                "partial_ratio": round(float(fuzz.partial_ratio(a, b)), ROUND),
            }
        )

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.join(HERE, "expected.json"))


if __name__ == "__main__":
    main()
