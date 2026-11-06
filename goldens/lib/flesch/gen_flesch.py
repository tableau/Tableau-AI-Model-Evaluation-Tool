#!/usr/bin/env python3
"""Generate expected.json for the flesch micro-golden.

Readability score normalization:
    round(Readability(text).flesch().score / 100, 4)

BLOCKED (partial): py-readability-metrics computes the sentence count via
nltk.tokenize.sent_tokenize, which needs the 'punkt_tab' resource. In THIS
environment that download is blocked by a local SSRF proxy (Security Violation,
restricted IP). We therefore CANNOT call Readability(text).flesch() end-to-end.

What we CAN do faithfully (no punkt required):
  * word tokenization via nltk TweetTokenizer  (readability.text.analyzer._tokenize)
  * punctuation filtering                        (readability.text.analyzer._is_punctuation)
  * per-word syllable count                      (readability.text.syllables.count)
  * letter count
These are EXACTLY the routines the library uses for num_words / num_syllables /
num_letters. We record those raw counts plus a 'manual_sentence_count' supplied
in inputs.json, and compute the Flesch score with the library's own formula
(readability.scorers.flesch.Flesch._score):

    206.835 - 1.015*(num_words/num_sentences) - 84.6*(num_syllables/num_words)

The TS port can be checked against (a) these word/syllable counts and (b) the
formula, decoupling the JS sentence tokenizer (which must produce the recorded
manual_sentence_count on these inputs) from the arithmetic.

Reads inputs.json, writes expected.json. Idempotent. Does NOT trigger any download.
"""
import json
import os
import re

from nltk.tokenize import TweetTokenizer
from readability.text.syllables import count as count_syllables

HERE = os.path.dirname(os.path.abspath(__file__))
ROUND = 4  # matches the reference code's round(score/100, 4)

# copied verbatim from readability.text.analyzer._is_punctuation
_PUNCT_RE = re.compile(r"^[.,\/#!$%\'\^&\*;:{}=\-_`~()]$")


def is_punctuation(token):
    return _PUNCT_RE.match(token) is not None


def word_stats(text):
    """Replicates readability.text.analyzer._statistics for the fields Flesch needs."""
    tokens = TweetTokenizer().tokenize(text)
    num_words = 0
    num_syllables = 0
    num_letters = 0
    for t in tokens:
        if not is_punctuation(t):
            num_words += 1
            num_syllables += count_syllables(t)
            num_letters += len(t)
    return num_words, num_syllables, num_letters


def flesch_score(num_words, num_sentences, num_syllables):
    words_per_sent = num_words / num_sentences
    syllables_per_word = num_syllables / num_words
    return 206.835 - (1.015 * words_per_sent) - (84.6 * syllables_per_word)


def main():
    with open(os.path.join(HERE, "inputs.json")) as f:
        inputs = json.load(f)

    out = {
        "_generated_by": "gen_flesch.py",
        "_rounding_decimals": ROUND,
        "_library": "py-readability-metrics (word/syllable tokenization) + Flesch formula",
        "_status": "PARTIALLY BLOCKED",
        "_blocked_reason": "nltk 'punkt_tab' download blocked by local SSRF proxy; "
        "Readability(text).flesch() cannot run end-to-end. num_sentences comes from "
        "sent_tokenize (punkt). We record raw word/syllable/letter counts (which do NOT "
        "need punkt) plus a manual_sentence_count and compute the Flesch score via the "
        "library's own formula.",
        "_flesch_formula": "206.835 - 1.015*(num_words/num_sentences) - 84.6*(num_syllables/num_words)",
        "_reference_transform": "round(flesch_score / 100, 4)",
        "paragraphs": [],
    }

    for para in inputs["paragraphs"]:
        nw, ns_yl, nl = word_stats(para["text"])
        num_sentences = para["manual_sentence_count"]
        raw = flesch_score(nw, num_sentences, ns_yl)
        out["paragraphs"].append(
            {
                "name": para["name"],
                "num_words": nw,
                "num_syllables": ns_yl,
                "num_letters": nl,
                "num_sentences_manual": num_sentences,
                "flesch_score_raw": round(raw, ROUND),
                "flesch_score_div100": round(raw / 100, ROUND),
                "_note": "flesch_score_div100 is what ReadabilityScorer stores. "
                "num_sentences is MANUAL (punkt blocked); TS port's sentence tokenizer "
                "must reproduce num_sentences_manual on this text for parity.",
            }
        )

    with open(os.path.join(HERE, "expected.json"), "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("wrote", os.path.join(HERE, "expected.json"))


if __name__ == "__main__":
    main()
