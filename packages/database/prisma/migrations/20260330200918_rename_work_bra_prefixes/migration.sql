-- Rename slug prefixes: WORK→WRK, BRA→BRN

-- Update existing workstream slugs
UPDATE workstreams SET slug = 'WRK' || substring(slug FROM 5) WHERE slug ~ '^WORK-';

-- Update existing branch/template artifact slugs (BRA was newly introduced; likely no rows yet)
UPDATE artifacts SET slug = 'BRN' || substring(slug FROM 4) WHERE slug ~ '^BRA-';

-- Rename slug_counter rows
UPDATE slug_counters SET type_prefix = 'WRK' WHERE type_prefix = 'WORK';
UPDATE slug_counters SET type_prefix = 'BRN' WHERE type_prefix = 'BRA';
