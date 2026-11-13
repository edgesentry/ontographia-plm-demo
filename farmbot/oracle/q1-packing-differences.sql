-- Q1: parts whose packing-list count disagrees with the part-page count.
--
-- The paired Intent projects the part name and the signed difference. The
-- comparison's container and product variant live on the COMPARED_IN and
-- FOR_VARIANT edges, which a single linear Intent traversal cannot bind
-- together with COMPARES_PART; see farmbot/intents/README.md.
SELECT
  part_name AS part,
  packing_minus_part AS packing_minus_part
FROM quantity_difference
ORDER BY part_name, packing_minus_part;
