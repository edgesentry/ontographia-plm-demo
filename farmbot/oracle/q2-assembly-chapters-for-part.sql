-- Q2: unique assembly chapters that reference the given part.
--
-- One row per assembly_reference row would repeat a chapter when the part is
-- referenced more than once on the page; the paired Intent therefore projects
-- DISTINCT, and this query does the same.
SELECT DISTINCT
  page.chapter AS chapter,
  page.path AS chapter_path,
  part.name AS part
FROM assembly_reference AS reference
JOIN assembly_page AS page ON page.path = reference.page_path
JOIN part ON part.name = reference.resolved_part
WHERE part.name = $part_name
ORDER BY chapter, chapter_path;
