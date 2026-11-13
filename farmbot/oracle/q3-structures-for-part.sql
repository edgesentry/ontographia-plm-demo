-- Q3: unique structures of any kind that use the given part.
--
-- The graph gives every reference row one owning Structure. Assembly references
-- belong to an AssemblyChapter; pre-assembly references belong to the
-- PreAssembly page, or to the Accessory bag node of that page (which carries
-- the same path); packing items belong to a Kit or to the Carton. The Intent
-- projects the structure path and therefore collides those owners when a page
-- owns both a bag and a pre-assembly, so this query projects the page path.
--
-- Unduplicated rows repeat a structure when the part is referenced more than
-- once by the same structure; the paired Intent projects DISTINCT.
SELECT DISTINCT
  owned.structure_path AS structure,
  part.name AS part
FROM (
  SELECT page_path AS structure_path, resolved_part AS part_name
  FROM assembly_reference
  UNION ALL
  SELECT page_path, resolved_part
  FROM preassembly_reference
  UNION ALL
  SELECT page_path, resolved_part
  FROM packing_item
) AS owned
JOIN part ON part.name = owned.part_name
WHERE part.name = $part_name
ORDER BY structure;
