# FarmBot checks

The check engine turns check Intents into findings. A check Intent is the same
JSON shape as a preset-question Intent: it names a start class, a linear
traversal chain, optional property filters and the projections to return. The
engine compiles it with `@edgesentry/ontographia-wasm` 0.1.9, executes it with
`@relate/relate-wasm` 1.0.1 against the committed seed, and evaluates a
deterministic rule in `src/farmbot/agent/`.

The same ESM modules run in Node and in the browser. `src/farmbot/agent/` has no
Node-only import: the caller supplies the compiler, the executor, the check
Intent JSON, the seed digest and a map from node id to source file.
`farmbot/scripts/agent-farmbot.mjs` is the Node entry; a browser screen will
supply the same values later.

## Rules

| ID | Direction | Check | Findings on the current seed |
|---|---|---|---|
| R1 | packing → design | packing quantity differs from the part page quantity | 12 |
| R2 | process → design | a reference in assembly, pre-assembly or packing does not resolve to a part | 13 names (19 lines) |
| R3 | design → process | part referenced by no process: no assembly chapter, pre-assembly, bag or packing list | 44 |
| R4 | packing → process | part packed but not referenced by any assembly chapter, pre-assembly or bag | 11 |
| R5 | all → document | pre-assembly page with no machine-readable parts table | 6 |

### R1: packing quantity differs from the part page

One finding per `quantity_difference` row, which is one part and one product
version. The rule joins three Intents on the difference node id: the compared
part, the packing container and the product variant. A part compared for both
`standard` and `xl` therefore produces two findings that share the part node.

### R2: a reference does not resolve to a part

One finding per distinct `display_name`, grouped in the rule module. The two
Intents keep the usage lines whose `match_method` is `unmatched`: one starts on
`AssemblyChapter`, the other on `ManufacturingContainer` (pre-assembly pages,
kits, the carton and bags). On the current seed the 19 lines are 4 in assembly
chapters, 9 in pre-assembly pages and 6 in packing lists.

### R3: a part referenced by no process

The engine has no negation, so the rule takes the part list and subtracts the
union of five reference Intents: assembly chapters, pre-assembly pages, bags,
kits and the carton. A bag owns the `Accessory bag BOM` section of a
pre-assembly page, so bags are a separate reference source.

### R4: a part packed but not referenced by a process

The packing references are the kit and carton Intents; the process references
are the assembly chapter, pre-assembly and bag Intents. Every packing reference
row carries its whole `Part` node, so R4 is derived from those rows; only R3
reads the full part list (`r3-parts.json`). A part is reported when it appears in
the packing references and in none of the process references. On the current
seed this is 11 parts. A part referenced only by pre-assembly pages is not
reported by R4; on the current seed `M3 Locknut` is referenced by four
pre-assembly pages.

### R5: a pre-assembly page with no machine-readable parts table

One finding per `PreAssembly` node whose `machine_readable` property is false.
On the current seed there are 6: 5 marked `pdf-only` and one index page with no
component list. The page contributes no usage lines, so its components cannot
appear in R3 or R4. R5 is a coverage limit and is always listed as a cause
candidate in those two rules.

## Check Intents

Every file under `farmbot/checks/` is a complete Intent. All traversals use
`direction: out` and start on the relationship's `from_class` side, because
Ontographia 0.1.9 rejects inbound steps (`edgesentry/ontographia#164`). No
Intent uses `DISTINCT`, negation, sums or branching; those operations belong to
the rule module (upstream issues `edgesentry/ontographia#166` and
`edgesentry/ontographia#167`).

| File | Start | Chain | Rule |
|---|---|---|---|
| `r1-quantity-difference.json` | `QuantityDifference` | `COMPARES_PART` → `Part` | R1 |
| `r1-compared-in.json` | `QuantityDifference` | `COMPARED_IN` → `ManufacturingContainer` | R1 |
| `r1-for-variant.json` | `QuantityDifference` | `FOR_VARIANT` → `ProductVariant` | R1 |
| `r2-assembly-unmatched.json` | `AssemblyChapter` | `HAS_USAGE` → `Usage` | R2 |
| `r2-manufacturing-unmatched.json` | `ManufacturingContainer` | `HAS_USAGE` → `Usage` | R2 |
| `r3-parts.json` | `Part` | — | R3 |
| `refs-assembly.json` | `AssemblyChapter` | `HAS_USAGE` → `Usage` → `USES_ITEM` → `Part` | R3, R4 |
| `refs-preassembly.json` | `PreAssembly` | `HAS_USAGE` → `Usage` → `USES_ITEM` → `Part` | R3, R4 |
| `refs-bag.json` | `Bag` | `HAS_USAGE` → `Usage` → `USES_ITEM` → `Part` | R3, R4 |
| `refs-kit.json` | `Kit` | `HAS_USAGE` → `Usage` → `USES_ITEM` → `Part` | R3, R4 |
| `refs-carton.json` | `Carton` | `HAS_USAGE` → `Usage` → `USES_ITEM` → `Part` | R3, R4 |
| `r5-unreadable-preassemblies.json` | `PreAssembly` | filter `machine_readable = false` | R5 |

The two R2 Intents bind `"unmatched"` as `$param_0`; the R5 Intent binds
`false` as `$param_0`. No other Intent carries a filter. Limits are 100 for the
small rules and 1000 for the part and reference lists; the runner throws if a
result reaches its limit, so a limit never truncates a finding silently.

`farmbot/checks/compiled.gold.json` pins the compiler output for every Intent
(query text and params). A test recompiles each file and requires an exact
match.

## Findings document

`npm run agent:farmbot` writes `farmbot/dist/farmbot.findings.json` and
`farmbot/dist/farmbot.findings.json.sha256`. The document has:

| Key | Content |
|---|---|
| `format` | `farmbot-findings-v1` |
| `seed` | `digest` from `farmbot.seed.json.sha256` and the seed `bytes` |
| `rules` | one entry per rule: direction, finding count, intent files, severity counts, title |
| `findings` | the findings, sorted by id |

Object keys are sorted at every level, the file is pretty-printed with two
spaces and ends in one newline. Array order is fixed: findings by id, evidence
rows by role and then node id, queries by Intent path, rules by rule id. No
timestamp, absolute path or host value is written.

The sidecar is one line, `farmbot-findings-v1 sha256:<64 lowercase hex>`, the
SHA-256 of the exact findings bytes. It follows the same style as
`farmbot.seed.json.sha256`.

The Node entry reads part page paths from the DuckDB extract
(`SELECT name, path FROM part`) and passes them to the engine. The extract is
not committed; in CI a test builds a private extract and passes `--extract`.
The rule evaluation itself never reads the extract.

`node farmbot/scripts/agent-farmbot.mjs --write-compiled-gold` regenerates the
compiled-Intent gold file.

## Finding id

A finding id is the rule id, a hyphen, and a lowercase ASCII slug of the
finding's subject key:

| Rule | Subject key |
|---|---|
| R1 | `<part name> <product variant code>` |
| R2 | unresolved display name |
| R3, R4 | part name |
| R5 | pre-assembly page path |

The slug keeps `[a-z0-9]`, turns every other run into one hyphen and trims
hyphens at both ends. When a slug is longer than 48 characters, or two subjects
in the same rule share a slug, the id ends with `-` plus eight lowercase hex
digits of an FNV-1a hash of the full subject key. Ids match
`^[A-Za-z0-9-]+$`, are unique within the document and are intended for
`#finding=<id>` deep links.

The id of a subject depends only on the set of subjects, not on the order in
which they are passed: subjects are sorted by rule and key before any collision
is resolved, and the ids are returned keyed by rule and subject key. A repeated
rule-and-key pair is rejected rather than given two ids.

## Evidence rows

Each finding has at least one evidence row:

| Field | Content |
|---|---|
| `nodeId` | seed node id, checked against `farmbot.seed.json` |
| `role` | what the node is in this finding |
| `sourceFile` | FarmBot document path, or `null` when no path exists |
| `line` | 1-based line number, or `null` when the source has none |
| `facts` | the values taken from that node for this finding |

Evidence roles are `quantity-difference`, `part`, `packing-line`,
`packing-structure`, `structure`, `reference` and `pre-assembly-page`.

Rows within one finding are unique by role, node id, source file and line: a
repeated row is the same citation of the same node and is dropped before the
rows are sorted. A structure node referenced on several lines of one page is
therefore cited once per finding.

Line numbers are available only on assembly and pre-assembly reference lines:
the `Usage` node copies `line_number` from `assembly_reference` or
`preassembly_reference`. The following kinds always emit `"line": null`:

- `part`: the `part` table has no line column.
- `quantity-difference`: derived from `quantity_difference`, which has no line.
- `packing-line` and `packing-structure`: `packing_item` stores table, row and
  child indexes, not a document line.
- `structure`: a page-level node.
- `pre-assembly-page`: `preassembly_page` has no line.
- R2 packing reference lines: `packing_item` has no line column.

A part evidence row's `sourceFile` is the part page path supplied by the Node
entry from the extract. If a caller supplies no source for a node, the field is
`null` rather than an invented path.

## Severity

Every finding carries four integer factors: `processesReached` (distinct
structure nodes in the finding), `productVariantsReached` (R1: distinct product
variant codes among the part's quantity differences; R3 and R4: the number of
product versions for which the part declares a quantity; other rules: 0),
`quantityDifference` (absolute packing-minus-part difference) and `overlap`
(the number of other findings with the same subject node id). The severity
score is

```
score = 2 * processesReached + productVariantsReached
      + min(quantityDifference, 10) + 2 * overlap
```

with `action` at 10 or more, `review` at 6 to 9, and `info` below 6. R3 and R4
are always `info`: they report a gap in the extract rather than a disagreement
between two documents, and the missing pre-assembly data can explain them
without any action on the part. The score and its factors are written into the
finding. On the current seed R1 has 11 action and 1 review, R2 has 2 review and
11 info, and R3, R4 and R5 are all info.

Overlap counts the other findings with the same subject node id. R1 findings for
the same part under `standard` and `xl` therefore both carry overlap 1; an R2
subject is a display name with no node id, so its overlap is 0.

## Causes and countermeasures

Causes come from fixed per-rule templates in `src/farmbot/agent/templates.mjs`.
Each cause is labelled `fact` when it restates an evidence value or a seed
property, and `inference` when it is a candidate explanation. A cause that
points at another rule carries that rule id. Every R3 and R4 finding includes
an inference with rule `R5`: the non-machine-readable pre-assembly pages cannot
contribute references, so the part may be listed on one of them. The finding
lists the page paths in that cause text.

The tool shows that two documents disagree. It does not decide which document
is right, and the countermeasures ask the reader to confirm the intended value
or add the missing reference.

## SQL oracles

Each rule has an independent DuckDB query under `farmbot/oracle/`. The test
compares the findings with these queries as sets (and as a multiset for R2,
which keeps one row per reference line):

| Oracle | Returned key | Rows on the current seed |
|---|---|---|
| `r1-packing-quantity.sql` | part, version, packing quantity, part quantity, difference, packing page | 12 |
| `r2-unresolved-references.sql` | display name, source file, line, source kind | 19 |
| `r3-unreferenced-parts.sql` | part name | 44 |
| `r4-packed-unreferenced-parts.sql` | part name | 11 |
| `r5-unreadable-preassemblies.sql` | page path, title, reason, PDF count | 6 |

## Verification

```sh
npm run agent:farmbot      # rebuild the findings and the sidecar
npm run test:farmbot       # compile gold, oracle equality, two-run byte match
```

The test rebuilds the findings in two private directories, compares them byte
for byte with the committed file, checks the sidecar digest, confirms that every
evidence node id exists in the committed seed, and confirms that the check
Intents are the only Cypher inputs recorded in the findings.
