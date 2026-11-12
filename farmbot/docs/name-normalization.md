# Display-name normalization

The BOM part pages use display titles such as `M5 x 10mm Screw`, while the
assembly and manufacturing pages refer to parts in prose and in packing-list
cells such as `[[M5 x 10mm Screws]]`, `Belt (1.7m)`, or
`X-Axis [[Cable Carrier]]`. The extract matches those references to the 149 BOM
part pages and records what it could not match. It never rewrites the source
names and never changes a quantity.

The matching is ours. It is a constructed correspondence between pages in the
pinned submodule; it is not an official FarmBot label.

## Matching order

Each display name is tried in this order. The first tier that produces exactly
one part wins.

1. **Exact title** — the reference equals a BOM `title`.
2. **Case-insensitive title** — the reference equals a `title` ignoring case.
3. **Normalized name** — both sides go through the normalization steps below.
4. **Singularized name** — the last word of the normalized name loses a
   trailing `s` when it is longer than three characters and does not end in
   `ss`.
5. **Qualifier-assisted normalized/singular name** — only for packing-list
   table items. The cell text in front of the link is used as a qualifier when
   the raw display name resolves to zero parts or to more than one part.

A tier that matches more than one part is treated as ambiguous. The extract
does not choose one of the candidates.

## Normalization steps

- Unicode NFKC, then lowercase.
- `×` and `✕` become `x`, and Unicode dashes become `-`.
- `w/` becomes `with `.
- Parenthesized suffixes are removed repeatedly. This covers length and
  configuration suffixes such as `Belt (1.7m)` and
  `Track Extrusion (20 x 40 x 1500mm)`. The suffix is descriptive; it is not
  matched as part of the name.
- Bracketed text is removed.
- `&` becomes `and`.
- Every run of characters outside `a-z0-9` becomes one space; leading and
  trailing spaces are removed.
- For the singularized tier only, the final word loses a trailing `s`
  (`Screws` to `Screw`, `Pulleys` to `Pulley`, `Zip Ties` to `Zip Tie`).

Length numbers remain part of a name (`M5 x 10mm Screw` is not reduced to
`M5 Screw`), because lengths distinguish individual parts.

## Qualifier-assisted matching

Some packing-list cells put the distinguishing words outside the link:

| Cell | Link name | Qualified name |
| --- | --- | --- |
| `X-Axis [[Cable Carrier]]` | `Cable Carrier` | `X-Axis Cable Carrier` |
| `Y-Axis [[Cable Carrier]]` | `Cable Carrier` | `Y-Axis Cable Carrier` |

`Cable Carrier` alone is ambiguous because the BOM has X-axis, Y-axis, and
Z-axis parts. The qualified name resolves to one part. Qualifiers are only
tried when the raw link name does not resolve, and the resulting row records
`qualified-exact`, `qualified-normalized`, or `qualified-singular` in
`packing_item.match_method`.

Qualifiers are not used for assembly prose. A phrase such as `wood screws`
stays unresolved there because the BOM has two wood-screw parts and the prose
does not say which one.

## Unmatched names

Every unresolved display name is written to `unmatched_name` with:

- `reference_count` — how many references used that exact spelling;
- `source_kinds` and `source_pages` — where it appeared;
- `status` — `unmatched` when no tier matched, `ambiguous` when a tier matched
  several parts;
- `candidates` — near candidates collected for diagnosis only. These are never
  used to resolve anything.

Examples from the pinned pages:

| Display name | Result | Why |
| --- | --- | --- |
| `M5 x 10mm Screws` | `M5 x 10mm Screw` | singular tier |
| `Belt (1.7m)` | `Belt` | parenthetical length suffix |
| `X-Axis [[Cable Carrier]]` | `X-Axis Cable Carrier` | qualifier-assisted |
| `Wood Screws` | unmatched, candidates `T10 Flathead Wood Screw`, `T25 Wood Screw` | the reference does not say which wood screw |
| `Tee Nuts` | unmatched | no BOM part page with that name |
| `Magnets` | unmatched, candidates `Countersunk Magnet`, `Standard Magnet` | the reference does not say which magnet |

Names that do not resolve are kept in the extract. They are not dropped and
they are not assigned to a nearest part.

## Quantities

Part quantities are read from the part-page frontmatter. For the twelve part
pages with a pipe-delimited `variants` field, `part.quantity_standard` and
`part.quantity_xl` are the sums of the positional variant quantities. Per
variant values are in `part_variant`.

Packing quantities are summed per packing page, part, and version
(`standard` or `xl`). Summing per page avoids counting a part twice when it
appears in more than one packing list. A version with no numeric quantity on
that page is not compared.

Nested components inherit the version applicability of the pack that contains
them. For example, a line inside the Genesis (XL) Screw Pack contributes to the
XL column only, and a line inside the Genesis Screw Pack contributes to the
standard column only. An empty or `-` quantity cell stays empty; the extract
does not copy a value from the other version.

A comparison is `match` when the sums agree, `difference` when both sides are
plain counts and disagree, and `not_comparable` when the packing cell uses a
non-count unit such as `1 pack` or `1 each`. Differences are written to
`quantity_difference` as they are; no quantity is corrected and no cause is
inferred.
