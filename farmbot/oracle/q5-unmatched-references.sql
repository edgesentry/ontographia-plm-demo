-- Q5: pages that reference an unmatched display name.
--
-- unmatched_name.source_pages is a comma-and-space separated list; the graph
-- emits one SEEN_IN edge per entry, so the list is unnested here.
SELECT
  name.display_name AS display_name,
  TRIM(page) AS page
FROM unmatched_name AS name,
  UNNEST(string_split(name.source_pages, ', ')) AS pages(page)
WHERE name.status = $status
ORDER BY display_name, page;
