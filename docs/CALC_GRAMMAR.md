# Calculation grammar and generation

The Calculated Fields validator uses the checked-in ANTLR grammar at
`packages/evals/src/validator/grammar/TableauCalculationGrammar.g4`.
Its author attribution is preserved. The grammar determines tokenization,
precedence, syntax and alternative selection; the tool does not maintain a
separate recursive-descent parser.

## No Java dependency

`antlr-ng` (pinned in the root `package.json` and `bun.lock`) generates TypeScript
under Bun. Generated code uses the existing `antlr4ng` runtime in `@tableau-ai-eval/evals`.
Neither generation nor the application needs Java, Python, or another checkout.
The generator is a development dependency, not shipped in the standalone binary.

```sh
bun generate:calc          # regenerate only when stale
bun generate:calc --force  # regenerate unconditionally
bun generate:calc --check  # fail if the checked-in cache is stale
```

On the development machine, generation takes approximately 0.27 seconds. Output
is nevertheless checked in to keep unchanged builds offline and avoid needless
rewrites. `scripts/generate-calc-parser.ts` hashes the grammar, generation script,
generator/runtime version pins, and both generated files. Changes to any input,
missing output, or modified output invalidate the cache. Generation happens in a
temporary directory; only successful generation updates the files and manifest.

Install, `bun start`, `bun dev`, and standalone compilation (including releases) check the
cache automatically. When using direct CLI entrypoints or tests after editing
the grammar, run `bun generate:calc` first. A test checks that the repository's
generated files are fresh, and another checks deterministic output, cache hits,
and regeneration after grammar/output changes.

Commit the grammar and all three files in `validator/generated/` together.
Generated files are excluded from lint and carry `@ts-nocheck` because the
generator emits unused template variables; handwritten adapters remain strictly
typechecked. `validator/lexer.ts` retains the existing token API, and
`validator/parser.ts` converts the generated labeled contexts into `ast.ts` for
the semantic validator. Syntax errors return no recovered AST. The semantic
validator and existing golden fixtures are unchanged.

## Prep uses a different grammar

Prep's editor-style grammar accepts incomplete constructs; it is not interchangeable
with the Calculated Fields grammar. Its source is checked in unchanged at
`packages/evals/src/prep/grammar/TableauExpression.g4`. The supplied grammar's
generated lexer/parser ATNs and rule names were verified to match the former
tables extracted from the bench's ANTLR 4.13 Python parser byte-for-byte.

`scripts/generate-prep-parser.ts` follows the same Java-free generation and
hash-based cache pattern as the Calculated Fields parser:

```sh
bun generate:prep          # regenerate only when stale
bun generate:prep --force  # regenerate unconditionally
bun generate:prep --check  # fail if the checked-in cache is stale
```

Install, `bun start`, `bun dev`, and standalone compilation (including releases)
check both parser caches. After editing the Prep grammar, regenerate before
running direct CLI entrypoints or tests. Commit the grammar and all three files
in `prep/generated/` together. Generated files are excluded from lint and carry
`@ts-nocheck`; the checker remains strictly typechecked. Tests pin existing Prep
diagnostics and verify cache freshness, deterministic generation, and regeneration
after grammar/output changes or missing output.

`prep/calc_checker.ts` uses the generated lexer/parser directly and still walks
rule names to detect incomplete constructs, unknown functions and unknown fields.
