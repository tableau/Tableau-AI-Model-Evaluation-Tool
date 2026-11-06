#!/usr/bin/env python3
"""Generate expected.json for the ciede2000 micro-golden.

Reference color conversion and difference operations:
  * delta_e_cie2000 (~L2036): float(delta_E_CIE2000(lab1, lab2).item())
  * hex_to_lab (~L2018): sRGB(0-1) -> colour.sRGB_to_XYZ -> colour.XYZ_to_Lab
  * calculate_color_distances (~L2054): pairwise delta-E for all combinations
  * ColorPaletteDistinguishability._compute (~L2160-2182) aggregation:
        min_distance = min pairwise distance
        if min_distance >= threshold: score = 1.0
        else: score = max(0.0, min(1.0, min_distance / threshold))

We import delta_E_CIE2000 + colour directly (light deps). The palette aggregation
formula is replicated here from the reference source (importing the metric class
would require unrelated dependencies, so
instructions we do the raw delta-E via colour-science and replicate the pure-python
aggregation, which is a faithful copy of the referenced lines).

Reads inputs.json, writes expected.json. Idempotent.
"""
import json
import os
from itertools import combinations

import numpy as np
import colour
from colour.difference import delta_E_CIE2000

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND = 10


def hex_to_lab(hex_color):
    hex_color = hex_color.lstrip("#")
    rgb_normalized = np.array(
        [
            int(hex_color[0:2], 16) / 255.0,
            int(hex_color[2:4], 16) / 255.0,
            int(hex_color[4:6], 16) / 255.0,
        ]
    )
    xyz = colour.sRGB_to_XYZ(rgb_normalized)
    return colour.XYZ_to_Lab(xyz)


def delta_e(lab1, lab2):
    return float(delta_E_CIE2000(np.array(lab1, dtype=float), np.array(lab2, dtype=float)).item())


def distinguishability_score(colors, threshold):
    # Faithful copy of ColorPaletteDistinguishability._compute aggregation.
    lab_colors = [(i, hex_to_lab(c)) for i, c in enumerate(colors)]
    if len(lab_colors) < 2:
        return {"score": 0.0, "min_distance": None, "distances": []}
    distances = []
    for (i1, l1), (i2, l2) in combinations(lab_colors, 2):
        distances.append([i1, i2, round(delta_e(l1, l2), ROUND)])
    min_distance = min(d[2] for d in distances)
    if min_distance >= threshold:
        score = 1.0
    else:
        ratio = min_distance / threshold
        score = max(0.0, min(1.0, ratio))
    return {
        "score": round(float(score), ROUND),
        "min_distance": round(float(min_distance), ROUND),
        "distances": distances,
    }


def main():
    with open(os.path.join(HERE, "inputs.json")) as f:
        inputs = json.load(f)
    threshold = inputs["min_distance_threshold"]

    out = {
        "_generated_by": "gen_ciede2000.py",
        "_rounding_decimals": ROUND,
        "_library": "colour-science (delta_E_CIE2000, sRGB_to_XYZ, XYZ_to_Lab)",
        "_min_distance_threshold": threshold,
        "lab_pairs": [],
        "hex_pairs": [],
        "palettes": [],
    }

    for p in inputs["lab_pairs"]:
        out["lab_pairs"].append(
            {"name": p["name"], "delta_e": round(delta_e(p["lab1"], p["lab2"]), ROUND)}
        )

    for p in inputs["hex_pairs"]:
        lab1 = hex_to_lab(p["hex1"])
        lab2 = hex_to_lab(p["hex2"])
        out["hex_pairs"].append(
            {
                "name": p["name"],
                "lab1": [round(float(x), ROUND) for x in lab1.tolist()],
                "lab2": [round(float(x), ROUND) for x in lab2.tolist()],
                "delta_e": round(delta_e(lab1, lab2), ROUND),
            }
        )

    for pal in inputs["palettes"]:
        agg = distinguishability_score(pal["colors"], threshold)
        out["palettes"].append({"name": pal["name"], **agg})

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.join(HERE, "expected.json"))


if __name__ == "__main__":
    main()
