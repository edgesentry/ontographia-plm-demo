-- Q4: kit usage lines whose part belongs to the given BOM category.
--
-- The main carton page is a Carton, not a Kit, and pallet-stacking.md carries
-- no references, so both are excluded. No DISTINCT: the Intent returns one row
-- per usage line, and a kit that lists the same part twice returns two rows.
SELECT
  page.path AS kit,
  category.slug AS category,
  part.name AS part
FROM packing_item AS item
JOIN packing_page AS page ON page.path = item.page_path
JOIN part ON part.name = item.resolved_part
JOIN bom_category AS category ON category.slug = part.category_slug
WHERE category.slug = $category_slug
  AND page.path NOT LIKE '%/main-carton.md'
  AND page.path NOT LIKE '%/pallet-stacking.md'
ORDER BY kit, part;
