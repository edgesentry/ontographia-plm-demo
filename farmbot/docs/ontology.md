# FarmBot Genesis ontology

This document describes the standalone ontology in
`farmbot/ontology/farmbot.native.yaml` and how it maps onto the DuckDB extract
built by `farmbot/scripts/extract.mjs`.

## Purpose

The ontology models one pinned release of the FarmBot Genesis documentation
set (v1.7): its parts, the two product versions, the assembly chapters, the
pre-assembly pages, the packing lists, and the comparisons and unmatched
names that the extract derives. It exists so that intents can be compiled
into Cypher against a named, typed schema instead of against column names
guessed at query time.

The file is self-contained. It does not import, extend, wrap or copy any
other ontology in this repository or elsewhere, and it is not tied to the
unrelated product-structure demo that also lives here: different namespace,
different classes, different tables. Nothing in the FarmBot path reads from
or writes to that demo.

## Manage the generation logic, not the graph

The repository holds three things: the ontology, the deterministic code that
turns the extract into graph data (added later), and the digests of the
extract. The DuckDB file and any graph store are build outputs: they are
produced in CI and thrown away. Only the digests are committed. A change in
the graph is therefore always explained by a change in the ontology, the
generation code, or the pinned source, never by someone editing a store by
hand.

## Class model

`Item` and `Structure` are abstract. `Item` is the target of every usage
line, so `USES_ITEM` can be declared once for parts and containers alike.
`Structure` is the owner of every usage line, so `HAS_USAGE` can be declared
once for assembly chapters and containers alike. `ManufacturingContainer`
inherits from both, which is what makes a container usable as a component of
another container.

| Class | Superclasses | Source | Meaning |
|---|---|---|---|
| Item | — | none (abstract) | Anything a usage line can point at |
| Structure | — | none (abstract) | Anything that owns usage lines |
| Part | Item | `part` | A part page in the BOM |
| PartVariant | — | `part_variant` | One option of a part, e.g. a length |
| BomCategory | — | `bom_category` | A BOM category page |
| ProductVariant | — | two fixed nodes | A version of the machine as a whole |
| AssemblyChapter | Structure | `assembly_page` | One assembly chapter (constructed EBOM grouping) |
| ManufacturingContainer | Item, Structure | none (abstract) | A container in the constructed MBOM view |
| PreAssembly | ManufacturingContainer | `preassembly_page` | A pre-assembly page |
| Kit | ManufacturingContainer | `packing_page` | A packing page that lists a kit |
| Bag | ManufacturingContainer | `packing_item`, `preassembly_reference` | A bag inside a kit |
| Carton | ManufacturingContainer | `packing_page` | The main carton page |
| Usage | — | `assembly_reference`, `preassembly_reference`, `packing_item` | One reference line |
| Correspondence | — | none (abstract) | A node derived by comparing the extract with itself |
| QuantityComparison | Correspondence | `quantity_comparison` | One packing-versus-part quantity comparison |
| QuantityDifference | QuantityComparison | `quantity_difference` | A comparison with a non-zero difference |
| UnmatchedName | Correspondence | `unmatched_name` | A display name that did not resolve |

`QuantityDifference` is a subclass of `QuantityComparison`, not a separate
kind of node: both describe one comparison, and the subclass only marks the
subset whose packing count disagrees with the part page.

### Constructed views, not official labels

The engineering BOM grouping (assembly chapters) and the manufacturing BOM
grouping (pre-assembly, kit, bag, carton) are views this repository
constructs from the documentation. "EBOM" and "MBOM" are our shorthand. They
are not official FarmBot labels, and the model does not claim to reproduce
how FarmBot organises or builds its product.

## Relationships

Every relationship is declared exactly once and points outward
(`direction: out`). There are no relationship properties in the native
format; see the modelling rules for where the per-link facts went.

| Relationship | From | To | Derived from |
|---|---|---|---|
| IN_CATEGORY | Part | BomCategory | `part.category_slug` → `bom_category.slug` |
| HAS_PART_VARIANT | Part | PartVariant | `part_variant.part_name` |
| HAS_USAGE | Structure | Usage | the page path of each reference row |
| USES_ITEM | Usage | Item | the resolved part or container of the row |
| APPLIES_TO | Usage | ProductVariant | the version the row's section or column applies to |
| COMPARES_PART | QuantityComparison | Part | `quantity_comparison.part_name` |
| COMPARED_IN | QuantityComparison | ManufacturingContainer | `quantity_comparison.packing_page` |
| FOR_VARIANT | QuantityComparison | ProductVariant | `quantity_comparison.version` |
| SEEN_IN | UnmatchedName | Structure | `unmatched_name.source_pages` |
| CANDIDATE | UnmatchedName | Part | `unmatched_name.candidates` |

`SEEN_IN` and `CANDIDATE` are many-to-many in practice, because a name can be
seen on several pages and can have several candidate parts. `CANDIDATE` only
has targets when the extract recorded candidates; many unmatched names have
none. `APPLIES_TO` is only set where a row is unambiguously tied to one
version; a row that applies to both is left without that edge rather than
duplicated.

## Properties

Property names are DuckDB column names, except for the four documented
derivations at the end of this section. Datatypes follow the column types:
`VARCHAR` → `string`, `INTEGER` → `integer`, `BOOLEAN` → `boolean`.

### Part (`part`)

| Property | Datatype | Column | Notes |
|---|---|---|---|
| name | string | `name` | Required, unique; the join key everywhere |
| slug | string | `slug` | |
| category_slug | string | `category_slug` | Also the key for `IN_CATEGORY` |
| quantity_standard | integer | `quantity_standard` | Summed over variant options |
| quantity_xl | integer | `quantity_xl` | Summed over variant options |
| has_variants | boolean | `has_variants` | |
| market_price | string | `market_price` | Kept as text: the source mixes currencies and ranges |

### PartVariant (`part_variant`)

| Property | Datatype | Column |
|---|---|---|
| part_name | string | `part_name` |
| variant_index | integer | `variant_index` |
| label | string | `label` |
| length | string | `length` |
| internal_part_name | string | `internal_part_name` |
| quantity_standard | integer | `quantity_standard` |
| quantity_xl | integer | `quantity_xl` |

### ProductVariant (no source table)

| Property | Datatype | Notes |
|---|---|---|
| code | string | Required, unique. `standard` or `xl`, matching the `version` values in the extract |
| label | string | `Genesis` or `Genesis XL` |

The extract stores versions as a column value, not as a table. The generation
code therefore creates exactly two `ProductVariant` nodes and resolves the
`version` column to `code`.

### Structure, AssemblyChapter, PreAssembly

`path` and `title` are owned by `Structure` and are present in all three page
tables (`assembly_page`, `preassembly_page`, `packing_page`) under the same
names.

| Class | Property | Datatype | Source column |
|---|---|---|---|
| Structure | path | string | `path` (required, unique in every page table) |
| Structure | title | string | `title` |
| AssemblyChapter | chapter | string | `assembly_page.chapter` |
| AssemblyChapter | reference_count | integer | `assembly_page.reference_count` |
| PreAssembly | machine_readable | boolean | `preassembly_page.machine_readable` |
| PreAssembly | machine_readable_reason | string | `preassembly_page.machine_readable_reason` |
| PreAssembly | pdf_count | integer | `preassembly_page.pdf_count` |

### Usage (three reference tables)

| Property | Datatype | Column | Notes |
|---|---|---|---|
| quantity | integer | see below | Derived |
| quantity_text | string | `preassembly_reference.quantity_text` | The literal cell text |
| unit | string | see below | Derived |
| section | string | `preassembly_reference.section`, `packing_item.section` | Null for assembly references |
| source_kind | string | `preassembly_reference.source_kind` | `table` or `prose` |
| line_number | integer | `assembly_reference.line_number`, `preassembly_reference.line_number` | |
| display_name | string | `display_name` in all three tables | The text as written |
| match_method | string | `match_method` in all three tables | How the name resolved |
| sub_packing | string | `packing_item.sub_packing` | e.g. `Press-to-seal bag` |

`Usage.quantity` is derived. For a pre-assembly reference it is
`preassembly_reference.quantity`. For a packing item it is the
`packing_item` quantity for the applicable version: `quantity_standard` when
the usage applies to `standard`, `quantity_xl` when it applies to `xl`. For
an assembly reference it is null, because assembly chapters list parts without
quantities.

`Usage.unit` is derived from `packing_item.quantity_standard_unit` or
`packing_item.quantity_xl_unit`, whichever version the usage applies to. It
is null for references that carry a bare count.

### QuantityComparison (`quantity_comparison`)

| Property | Datatype | Column |
|---|---|---|
| packing_quantity | integer | `packing_quantity` |
| part_quantity | integer | `part_quantity` |
| difference | integer | `difference` |
| status | string | `status` |
| note | string | `note` |
| sections | string | `sections` |

### QuantityDifference (`quantity_difference`)

| Property | Datatype | Column |
|---|---|---|
| packing_minus_part | integer | `packing_minus_part` |

Inherited properties come from `quantity_comparison`; the difference table
repeats the same rows and adds the signed difference. One node per row of
`quantity_difference`, with both `COMPARES_PART` and `COMPARED_IN` set from
the row's keys.

### UnmatchedName (`unmatched_name`)

| Property | Datatype | Column |
|---|---|---|
| display_name | string | `display_name` |
| normalized_name | string | `normalized_name` |
| singular_name | string | `singular_name` |
| reference_count | integer | `reference_count` |
| source_kinds | string | `source_kinds` |
| status | string | `status` |

## Modelling rules

1. **Quantity lives on a usage node.** The native format has no relationship
   properties, so the count belongs to the `Usage` node rather than to
   `HAS_USAGE` or `USES_ITEM`. A consumer reading a quantity reads it from
   the usage line, not from the edge.

2. **Two kinds of variant.** `ProductVariant.code` is `standard` or `xl`,
   the values of the extract's `version` column. `Part` keeps
   `quantity_standard` and `quantity_xl` because the part page declares both
   counts itself. `PartVariant` is a different concept: it is an option of a
   part, such as a length, with its own row in `part_variant`.

3. **Comparisons and name resolution.** `QuantityDifference` is a subclass of
   `QuantityComparison`, and there is one node per comparison row, so a
   difference can be queried either as a comparison or as a difference.
   `Usage.match_method` records how each reference resolved (exact,
   normalized, qualified and so on), which is how a query can separate solid
   links from fuzzy ones.

4. **Container classification by page path.** A pre-assembly page
   (`v1.7/manufacturing/pre-assembly/**`) becomes a `PreAssembly`. The page
   `v1.7/manufacturing/packing/main-carton.md` becomes the `Carton`. The
   other packing pages that carry a packing list (`extrusion-kit`,
   `hardware-kit`, `motor-kit`, `power-supply`, `solenoid-valve`,
   `vacuum-pump`) become `Kit`. `pallet-stacking.md` has no references and is
   not modelled.

5. **Bags are narrow.** Only `packing_item` rows with `item_kind = 'pack'`
   (three rows) and the `Accessory bag BOM` section of the pre-assembly pages
   produce `Bag` nodes. An ordinary item whose `sub_packing` column reads
   `Press-to-seal bag` does not create a bag; that value stays a `Usage`
   attribute. In the current extract, component rows of a pack row keep the
   kit page path and record the pack label as plain text in `parent_item`,
   so components cannot yet be attached to a bag by key.

6. **Carton-to-kit nesting is expressible but not populated.** `USES_ITEM`
   points at `Item`, and `ManufacturingContainer` is an `Item`, so a carton
   can use a kit as a component without another relationship name. The
   extract does not build those edges today, because the main carton page
   links kits with plain Markdown links instead of wikilinks. Filling them
   needs a separate extract change.

7. **Ontographia 0.1.9 limitations.**
   (a) With `direction: in`, validation still checks the relationship's
   `from_class` against the previous node's class. Intents must therefore
   start from the `from_class` side and traverse outward.
   (b) Loading an ontology does not reject a relationship that names an
   undeclared class, a duplicate relationship name, or an unknown key; the
   parser ignores what it does not know. The test in
   `farmbot/test/ontology.test.mjs` performs those checks itself, so a
   malformed ontology fails the test suite rather than passing silently at
   load time.

## Validation

The unit test parses the YAML and checks the shape of the declaration, checks
that every named class exists, checks the datatypes and directions against the
allowed sets, and checks that every modelled property (except the four
documented derivations) is a real column of a mapped source table in the
DuckDB extract. It also compiles a few intents through the WebAssembly
binding to confirm that the declared relationships produce the expected
Cypher. When the extract is missing, the test builds it with the existing
extract script.
