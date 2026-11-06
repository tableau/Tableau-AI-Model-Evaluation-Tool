# Matched fields per case

The prompt-only runner (calc-prompt) does not search a datasource itself; it reads the fields to show the model
from one file per test case, named after the case file: the dataset's field list with sample values. Files for
cases whose data was already public are the evaluator's own; the rest are generated from `../fixtures`.
Regenerate them with a live field search when one is available.
