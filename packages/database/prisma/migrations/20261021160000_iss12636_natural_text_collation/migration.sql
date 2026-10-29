-- ISS-12636: the collation `ListQueryTextOrdering.Natural` names.
--
-- `numeric: true` on the TypeScript mirror is ICU's `kn` keyword, and Postgres
-- ships no predefined collation carrying it, so the SQL mirror of a slug sort
-- has nothing to name without this. The name IS the locale so the two mirrors
-- agree from one spelling each; Postgres reports the canonical form `en-u-kn`
-- for the `en-u-kn-true` it is given.
--
-- `en` rather than `und` for the reason `LIST_QUERY_COLLATED_LOCALE` records:
-- `und` is read as "no preference" and resolves to the host locale on the
-- TypeScript side, so the pair would agree only on a host whose locale happens
-- to carry no tailoring.
CREATE COLLATION IF NOT EXISTS "en-u-kn" (
  provider = icu,
  locale = 'en-u-kn-true',
  deterministic = true
);
