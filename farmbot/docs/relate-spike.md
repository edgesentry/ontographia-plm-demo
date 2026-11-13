# Relate WASM compatibility spike (Issue #27)

This document records a compatibility spike, not production graph generation.
It answers one question for epic #26: can the Cypher 25 that Ontographia
compiles from the FarmBot Intents actually run on `@relate/relate-wasm`?

Everything below was measured by running `farmbot/scripts/spike-relate.mjs`
against the DuckDB extract built by `farmbot/scripts/extract.mjs`. No number in
this document is estimated.

## Versions tested

| Component | Version |
|---|---|
| Node.js | v22.23.5 |
| `@edgesentry/ontographia-wasm` | 0.1.9 |
| `@relate/relate-wasm` | 1.0.1 |
| DuckDB extract schema | 1, canonical SHA-256 `6c32e7067b21679531fd7b6959670b76dcad461227137c96e54078a70ac3ee84` |

`@relate/relate-wasm` 1.0.0 was not installed or run. The brief makes the 1.0.0
rerun conditional on a query failing on 1.0.1 for an engine reason; no query
failed, so the fallback was not triggered.

## How the spike runs

```sh
npx -y node@22 farmbot/scripts/extract.mjs
npx -y node@22 farmbot/scripts/spike-relate.mjs --out <temp-dir>/relate-spike.json
```

The script reads the extract `READ_ONLY`, builds a seed that follows
`farmbot/ontology/farmbot.native.yaml`, loads it into `new RelateDb()`
(in-memory) with `UNWIND $rows AS row`, compiles each Intent with
`og.buildCypher(ontologyText, intent, { ontologyPathHint: 'farmbot.native.yaml' })`
and runs it with `db.execute(query, JSON.stringify(params))`. It prints one JSON
document (and writes the same document to `--out` when given). `--extract`
selects a different extract file; the default is `farmbot/dist/farmbot.duckdb`.

Because the native format has no way to say "abstract", abstractness is
represented by adding every ancestor label to the concrete nodes:

| Class | Labels on the node |
|---|---|
| Part | `Part`, `Item` |
| AssemblyChapter | `AssemblyChapter`, `Structure` |
| PreAssembly / Kit / Bag / Carton | own label, `ManufacturingContainer`, `Item`, `Structure` |
| QuantityComparison | `QuantityComparison`, `Correspondence` |
| QuantityDifference | `QuantityDifference`, `QuantityComparison`, `Correspondence` |
| UnmatchedName | `UnmatchedName`, `Correspondence` |

## Measured seed size

| Metric | Value |
|---|---|
| Nodes created | 601 |
| Nodes found by `MATCH (n) RETURN count(n)` | 601 |
| Relationships created | 1017 |
| Relationships found by `MATCH ()-[r]->() RETURN count(r)` | 1017 |
| Seed JSON passed to the loader (nodes + edges) | 289,816 bytes |
| Load plus verification queries | 887 ms |

Node counts by label (measured with a label count per label):

| Label | Nodes |
|---|---|
| Part | 149 |
| Item (abstract) | 173 |
| PartVariant | 44 |
| BomCategory | 8 |
| ProductVariant | 2 |
| AssemblyChapter | 9 |
| Structure (abstract) | 33 |
| PreAssembly | 12 |
| ManufacturingContainer (abstract) | 24 |
| Kit | 6 |
| Carton | 1 |
| Bag | 5 |
| Usage | 276 |
| QuantityComparison | 76 |
| Correspondence (abstract) | 89 |
| QuantityDifference | 12 |
| UnmatchedName | 13 |

Relationships by type (measured while loading):

| Type | Edges |
|---|---|
| HAS_USAGE | 276 |
| USES_ITEM | 257 |
| APPLIES_TO | 36 |
| COMPARES_PART | 76 |
| COMPARED_IN | 76 |
| FOR_VARIANT | 76 |
| SEEN_IN | 17 |
| CANDIDATE | 10 |
| IN_CATEGORY | 149 |
| HAS_PART_VARIANT | 44 |

Modelling choices in the seed, all taken from `farmbot/docs/ontology.md`:

- 276 `Usage` nodes: 160 `assembly_reference` rows, 54 `preassembly_reference`
  rows and 62 `packing_item` rows. The three `packing_item` rows with
  `item_kind = 'pack'` are `Bag` nodes, not usage lines.
- 5 `Bag` nodes: 3 from `pack` rows and 2 from the `Accessory bag BOM` section
  (rotary-tool, seeder). The 6 references in those two sections are owned by
  the bag, not by the enclosing pre-assembly page. The 3 pack-row bags have no
  usage lines because the extract records their components only as plain text.
- `APPLIES_TO` is set only where exactly one product version applies; a packing
  row that applies to both versions has no edge.
- Carton-to-kit nesting is not populated, matching the documented gap.
- `QuantityDifference` nodes are the 12 `difference` rows among the 76
  comparisons, carrying both labels rather than duplicating nodes.

## Query parameters

The Q2-Q5 parameter values were read from the extract and asserted by the
script before the graph is built.

| Intent | Parameter | Value | Where it occurs in the extract |
|---|---|---|---|
| Q2 | part name | `M5 x 10mm Screw` | `assembly_reference.resolved_part`, 7 rows |
| Q3 | part name | `M5 Flange Locknut` | `preassembly_reference.resolved_part` and `packing_item.resolved_part` |
| Q4 | category slug | `fasteners-and-hardware` | `bom_category.slug`, 40 parts |
| Q5 | unmatched status | `unmatched` | `unmatched_name.status` |

## Results

`Accepted` means the Intent compiled with Ontographia and `db.execute` returned
an envelope with `error: null`. Row counts are the envelope's `rows.length`.

| ID | Intent summary | Accepted | Rows | Engine `error` (verbatim) |
|---|---|---|---|---|
| Q1 | QuantityDifference → COMPARES_PART → Part; return part name and `packing_minus_part` | yes | 12 | `null` |
| Q2 | AssemblyChapter → HAS_USAGE → Usage → USES_ITEM → Part; filter part name | yes | 7 | `null` |
| Q3 | Structure (abstract) → HAS_USAGE → Usage → USES_ITEM → Part; filter part name | yes | 10 | `null` |
| Q4 | Kit → HAS_USAGE → Usage → USES_ITEM → Part → IN_CATEGORY → BomCategory; filter category slug | yes | 24 | `null` |
| Q5 | UnmatchedName → SEEN_IN → Structure; filter status | yes | 17 | `null` |
| P1 | Part; return the whole node | yes | 3 | `null` |
| P2 | BomCategory → IN_CATEGORY with `direction: in` to Part (the #164 shape) | no (compile) | — | compile error, not an engine error: `validation error: relationship 'IN_CATEGORY' does not originate from class 'BomCategory'` |
| P3 | Part → IN_CATEGORY (`direction: out`) → BomCategory; filter the far category alias | yes | 5 | `null` |

Q2 and Q3 return one row per matching usage line, so a chapter or structure
appears once per reference to the part (for example, Q2 returns
`cross-slide-and-z-axis` twice and `gantry` five times). These Intents do not
project DISTINCT and the spike did not add it, so the duplication is visible.

### Compiled Cypher

Q1:

```cypher
CYPHER 25
MATCH (d:QuantityDifference)-[:COMPARES_PART]->(p:Part)
RETURN p.name AS part, d.packing_minus_part AS packing_minus_part
LIMIT 20
```

Q2 (`params = {"param_0":"M5 x 10mm Screw"}`):

```cypher
CYPHER 25
MATCH (a:AssemblyChapter)-[:HAS_USAGE]->(u:Usage)-[:USES_ITEM]->(p:Part)
FILTER p.name = $param_0
RETURN a.chapter AS chapter, a.path AS chapter_path, p.name AS part
LIMIT 20
```

Q3 (`params = {"param_0":"M5 Flange Locknut"}`):

```cypher
CYPHER 25
MATCH (s:Structure)-[:HAS_USAGE]->(u:Usage)-[:USES_ITEM]->(p:Part)
FILTER p.name = $param_0
RETURN s.path AS structure, p.name AS part
LIMIT 50
```

Q4 (`params = {"param_0":"fasteners-and-hardware"}`):

```cypher
CYPHER 25
MATCH (k:Kit)-[:HAS_USAGE]->(u:Usage)-[:USES_ITEM]->(p:Part)-[:IN_CATEGORY]->(c:BomCategory)
FILTER c.slug = $param_0
RETURN k.path AS kit, c.slug AS category, p.name AS part
LIMIT 50
```

Q5 (`params = {"param_0":"unmatched"}`):

```cypher
CYPHER 25
MATCH (n:UnmatchedName)-[:SEEN_IN]->(s:Structure)
FILTER n.status = $param_0
RETURN n.display_name AS display_name, s.path AS page
LIMIT 50
```

P1:

```cypher
CYPHER 25
MATCH (p:Part)
RETURN p
LIMIT 3
```

P2 did not compile; there is no Cypher to show.

P3 (`params = {"param_0":"fasteners-and-hardware"}`):

```cypher
CYPHER 25
MATCH (p:Part)-[:IN_CATEGORY]->(c:BomCategory)
FILTER c.slug = $param_0
RETURN p.name AS part
LIMIT 5
```

## Findings

### CYPHER 25 compatibility

Relate 1.0.1 accepted every statement Ontographia emitted, including:

- the `CYPHER 25` prefix (all five queries and P1/P3 ran without a parse error);
- named `$param_N` parameters passed as a JSON object string;
- `FILTER <alias>.<property> = $param_N` (Ontographia uses `FILTER`, not
  `WHERE`);
- multi-label `CREATE (n:Part:Item)` and `SET n += row` inside
  `UNWIND $rows AS row`, used to seed the graph;
- pattern matching on property maps, `MATCH (a:Label {id: row.from})`, used to
  wire edges;
- a whole-node `RETURN p`. P1 returned 3 rows whose `p` value is
  `{id, kind, labels, properties}`; the labels array contained
  `["Part", "Item"]`.

### Abstract start classes

Q3 starts on `Structure`, which is abstract in the ontology and has no source
table. It compiled and returned 10 rows because the seed puts the `Structure`
label on every concrete page and container node (33 nodes in total). Nothing in
the compiler or the engine needed to know that `Structure` is abstract.

### The #164 forward-traversal workaround

`direction: in` is only accepted when the previous node is the relationship's
`from_class`. P2 starts on `BomCategory` and asks for `IN_CATEGORY` with
`direction: in` to reach `Part`; Ontographia rejects it with the verbatim
message quoted in the results table, before Relate is involved.

The workaround is to start on the `from_class` and filter on the far alias.
P3 asks the same category-centric question as P2 ("parts in a category") but
starts on `Part`, traverses `IN_CATEGORY` with `direction: out` and filters
`c.slug`; it compiles and returns 5 rows. Q3 applies the same shape to the
"part → structures" question: it starts on `Structure`, traverses out to
`Usage` and `Part`, and filters the `Part` alias. No query in this spike uses
`direction: in`.

## Decision

**Use `@relate/relate-wasm` 1.0.1, pinned exactly (`"1.0.1"`, no caret), for the
rest of epic #26.**

Evidence:

- All five preset-question Intents compiled and ran on 1.0.1 with
  `error: null`: Q1 12 rows, Q2 7 rows, Q3 10 rows, Q4 24 rows, Q5 17 rows.
- The three probes behaved as required: a whole-node return worked (P1, 3
  rows), the #164 shape was rejected at compile time with the documented
  message (P2), and the forward-traversal workaround ran (P3, 5 rows).
- 1.0.1 accepted the exact Cypher 25 text Ontographia emits, including the
  `CYPHER 25` prefix and `$param_N` parameters, without a dialect or vendor
  change.
- No engine error occurred, so the brief's 1.0.0 fallback was not needed and
  1.0.0 remains untested.

Open items for the epic, outside this spike: the seed is a hand-built fixture,
not the A2 generator; row duplication from multi-line usage is visible because
these Intents do not project DISTINCT; and the pack-row bags still have no
component edges.
