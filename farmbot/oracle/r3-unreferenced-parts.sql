-- R3: parts referenced by no assembly chapter, pre-assembly, bag or packing
-- list.
--
-- The graph query is the union of the five reference Intents. Ontographia
-- 0.1.9 has no negation, so the rule module subtracts that union from the part
-- list; this query states the same difference in SQL.
SELECT p.name AS part
FROM part AS p
WHERE NOT EXISTS (
    SELECT 1 FROM assembly_reference AS r WHERE r.resolved_part = p.name
  )
  AND NOT EXISTS (
    SELECT 1 FROM preassembly_reference AS r WHERE r.resolved_part = p.name
  )
  AND NOT EXISTS (
    SELECT 1 FROM packing_item AS r WHERE r.resolved_part = p.name
  )
ORDER BY p.name;
