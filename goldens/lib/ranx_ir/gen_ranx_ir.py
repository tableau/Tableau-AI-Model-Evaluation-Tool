#!/usr/bin/env python3
"""Generate expected.json for the ranx_ir micro-golden.

Reference ranking metrics:

    qrels = ranx.Qrels({query: {doc: rel,...}})
    run   = ranx.Run({query: {doc: score,...}})
    result = ranx.evaluate(qrels, ranx.Run(run), metric_list, make_comparable=True)

We evaluate the full metric list (hit_rate@1/5/10, map, mrr, precision, recall) in
one call, exactly as ranx.evaluate would when given a list.

Reads inputs.json, writes expected.json. Idempotent.
"""
import json
import os

import ranx

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND = 10


def evaluate_case(qrels_dict, run_dict, metrics):
    # ranx errors on a run whose query has an empty ranking; the reference code
    # never reaches ranx.evaluate in that situation (it returns 0.0 metrics or []
    # earlier). We record that behavior explicitly rather than fabricating values.
    for q, docs in run_dict.items():
        if len(docs) == 0:
            return {
                "_note": "run has an empty ranking for a query; ranx cannot build a Run. "
                "Reference code short-circuits before ranx.evaluate (returns 0.0 per metric "
                "when actual is empty, or [] when expected is empty). No ranx value exists.",
                "_ranx_evaluated": False,
            }
    qrels = ranx.Qrels(qrels_dict)
    run = ranx.Run(run_dict)
    result = ranx.evaluate(qrels, run, metrics, make_comparable=True)
    # ranx returns a dict when >1 metric requested.
    return {m: round(float(result[m]), ROUND) for m in metrics}


def main():
    with open(os.path.join(HERE, "inputs.json")) as f:
        inputs = json.load(f)

    metrics = inputs["metrics"]
    out = {
        "_generated_by": "gen_ranx_ir.py",
        "_rounding_decimals": ROUND,
        "_library": "ranx (Qrels/Run/evaluate, make_comparable=True)",
        "_metrics": metrics,
        "cases": [],
    }
    for case in inputs["cases"]:
        try:
            values = evaluate_case(case["qrels"], case["run"], metrics)
            err = None
        except Exception as e:  # capture any ranx error verbatim
            values = None
            err = f"{type(e).__name__}: {e}"
        out["cases"].append(
            {
                "name": case["name"],
                "metrics": values,
                "error": err,
            }
        )

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.join(HERE, "expected.json"))


if __name__ == "__main__":
    main()
