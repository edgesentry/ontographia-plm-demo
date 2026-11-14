-- R2: reference lines in assembly, pre-assembly or packing that do not resolve
-- to a part page.
--
-- The paired check Intents start on the structure side and keep the usage lines
-- whose match_method is `unmatched`. Packing rows carry no line number in the
-- extract, so their line is NULL here and in the finding evidence.
SELECT
  display_name AS name,
  page_path AS source_file,
  line_number AS line,
  'assembly' AS source_kind
FROM assembly_reference
WHERE resolved_part IS NULL AND match_method = 'unmatched'
UNION ALL
SELECT
  display_name,
  page_path,
  line_number,
  'pre-assembly'
FROM preassembly_reference
WHERE resolved_part IS NULL AND match_method = 'unmatched'
UNION ALL
SELECT
  display_name,
  page_path,
  NULL::INTEGER,
  'packing'
FROM packing_item
WHERE resolved_part IS NULL AND match_method = 'unmatched'
ORDER BY name, source_file, source_kind, line NULLS FIRST;
