-- ISS-7210: NUMBER custom fields gain a DURATION display format.
--
-- Storage is unchanged — a duration lives in the existing
-- `custom_field_values.number_value` double column. Its canonical unit is
-- MILLISECONDS; see the `NumberFormat` enum comment in schema.prisma.
--
-- Additive: no existing row carries the value, so no backfill.
ALTER TYPE "NumberFormat" ADD VALUE 'DURATION';
