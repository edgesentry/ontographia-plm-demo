-- R4: parts packed in a kit or the carton but referenced by no assembly
-- chapter, pre-assembly or bag.
--
-- Packing rows include the carton page and every kit page. Pre-assembly
-- references include the Accessory bag BOM section, which the graph owns with
-- a Bag node; those references count as process references here.
WITH packed AS (
  SELECT DISTINCT resolved_part AS part
  FROM packing_item
  WHERE resolved_part IS NOT NULL
)
SELECT packed.part
FROM packed
WHERE NOT EXISTS (
    SELECT 1 FROM assembly_reference AS r WHERE r.resolved_part = packed.part
  )
  AND NOT EXISTS (
    SELECT 1 FROM preassembly_reference AS r WHERE r.resolved_part = packed.part
  )
ORDER BY packed.part;
