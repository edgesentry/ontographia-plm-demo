-- R5: pre-assembly pages that have no machine-readable parts table.
--
-- These pages contribute no usage lines, so their components cannot be seen by
-- R3 or R4. R5 is reported as a coverage limit and used as a cause candidate.
SELECT
  path,
  title,
  machine_readable_reason,
  pdf_count
FROM preassembly_page
WHERE machine_readable = FALSE
ORDER BY path;
