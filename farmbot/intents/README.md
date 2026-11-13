# Preset question Intents

Five Intents, one per preset question, compiled by `@edgesentry/ontographia-wasm`
0.1.9 against `farmbot/ontology/farmbot.native.yaml` and executed by
`@relate/relate-wasm` 1.0.1 against the committed seed
`farmbot/dist/farmbot.seed.json` in `farmbot/test/preset-questions.test.mjs`
and on the `/farmbot/` screen.
Each file under `farmbot/oracle/` is an independent SQL answer over the DuckDB
extract and returns the same column names as its Intent.

| File | Question | Pattern | Parameter | Returned columns |
|---|---|---|---|---|
| `q1-packing-differences.json` | Which parts disagree between the packing list and the BOM? | `QuantityDifference -COMPARES_PART-> Part` | none | `part`, `packing_minus_part` |
| `q2-assembly-chapters-for-part.json` | Which assembly chapters use this part? | `AssemblyChapter -HAS_USAGE-> Usage -USES_ITEM-> Part` | part name | `chapter`, `chapter_path`, `part` |
| `q3-structures-for-part.json` | If this part changes, what does it reach? | `Structure -HAS_USAGE-> Usage -USES_ITEM-> Part` | part name | `structure`, `part` |
| `q4-kit-parts-for-category.json` | Which kits contain parts of this category? | `Kit -HAS_USAGE-> Usage -USES_ITEM-> Part -IN_CATEGORY-> BomCategory` | category slug | `kit`, `category`, `part` |
| `q5-unmatched-references.json` | Which references did not resolve to a part page? | `UnmatchedName -SEEN_IN-> Structure` | unmatched status | `display_name`, `page` |

Every `limit` is 100. The largest measured answer is 24 rows (Q4), and the test
fails if any result reaches its limit, so a limit can never truncate a real
answer silently.

## Parameters

A filter value is stored in the Intent JSON because the 0.1.9 Intent schema
takes a literal `value`; the compiler then emits it as `$param_N` and returns
the value in `params`. The compiled Cypher text contains no part name, category
slug or status literal. The test compiles each Intent and asserts both the
placeholder and the absence of the literal, then passes the compiler's `params`
object to Relate unchanged.

Filter values must come from the extract. The generated list of allowed values
is `farmbot/dist/farmbot.allowed-values.json`, written by
`farmbot/scripts/allowed-values.mjs`:

```sh
npx -y node@22 farmbot/scripts/allowed-values.mjs
```

The script opens the extract read-only and writes one JSON object with the
format token `farmbot-allowed-values-v1` and these alphabetically sorted string
arrays:

| Key | Domain |
|---|---|
| `part_names` | every `part.name` |
| `part_names_in_assembly_chapters` | distinct `assembly_reference.resolved_part` |
| `part_names_in_preassemblies` | distinct `preassembly_reference.resolved_part`, excluding `Accessory bag BOM` rows (their owning structure is a bag) |
| `part_names_in_kits` | distinct `packing_item.resolved_part` on kit pages (main carton and `pallet-stacking.md` excluded) |
| `part_names_in_all_three_structure_kinds` | intersection of the three domains above |
| `category_slugs` | every `bom_category.slug` |
| `category_slugs_in_kits` | distinct `part.category_slug` for kit usage lines |
| `unmatched_statuses` | distinct `unmatched_name.status` |

Object keys are sorted, arrays are sorted by code unit, and the file ends with
one newline, so a fresh generation is byte-identical. The test regenerates the
file from a private extract copy and compares bytes, and it asserts that every
filter value used by the five Intents is a member of its domain.

## Forward traversal only

Ontographia 0.1.9 rejects `direction: in` when the previous node is not the
relationship's `from_class`, even though the requested edge would arrive from
`to_class` (`edgesentry/ontographia#164`). Every shipped Intent therefore starts
on the relationship's `from_class` and traverses `direction: out`, filtering on
the alias at the far end when the question is naturally asked from the other
side. No shipped Intent uses `direction: in`; the test checks every `traverse`
step.

## Unique chapters and structures (Q2 and Q3)

A part can be referenced more than once by the same chapter or structure, and
the raw pattern then returns one row per usage line. Both questions want unique
owners.

Ontographia 0.1.9 cannot express `DISTINCT`: the Intent schema has no such
field (unknown keys are rejected) and the Cypher 25 emitter writes `RETURN`
without `DISTINCT`. For Q2 and Q3 only, a post-compile step runs before
execution: it replaces the statement's single `\nRETURN ` with
`\nRETURN DISTINCT ` and leaves every other byte, including the `$param_N`
placeholders, exactly as compiled. The step is
`insertDistinctReturn` in `src/farmbot/distinct-return.mjs`, shared by the
preset-question tests and the `/farmbot/` screen so the rewrite cannot drift;
nothing in the ontology or the compiler changes.

The test asserts that the raw compiler output for Q2 and Q3 does not contain
`DISTINCT`, that the executed statement does, and that the returned rows are
unique. The matching SQL queries use `SELECT DISTINCT`. Q1, Q4 and Q5 are not
post-processed and keep the engine's row multiplicity.

## Why Q1 returns no container or variant column

The committed graph attaches the packing container through `COMPARED_IN` and
the product variant through `FOR_VARIANT`. Both are separate outgoing edges
from the same `QuantityDifference` node, while a 0.1.9 traversal is one linear
chain, and the far side cannot be entered with `direction: in`
(`edgesentry/ontographia#164`). One Intent therefore cannot bind the compared
part, its container and its variant together. The shipped Q1 Intent starts on
`QuantityDifference`, traverses `COMPARES_PART` to `Part`, and projects the part
name and `packing_minus_part`; the oracle projects the same two columns. The
test adds a companion check: the extract's difference rows fall on the hardware
kit page for both `standard` and `xl`, and that page is a `Kit` in the seed.
