-- R1: packing-list quantities that disagree with the part page.
--
-- One row per quantity_difference record, which is one part and one product
-- version. The paired check Intents project the difference, the compared part,
-- the packing container and the product variant; the rule module joins them on
-- the difference node id.
SELECT
  part_name AS part,
  version,
  packing_quantity,
  part_quantity,
  packing_minus_part,
  packing_page
FROM quantity_difference
ORDER BY part_name, version, packing_page;
