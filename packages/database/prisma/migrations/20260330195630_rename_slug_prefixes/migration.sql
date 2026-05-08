-- Rename slug prefixes: PROJ→PRO, FEAT→FEA, PLAN→PLN
-- PRD and WORK are unchanged.

-- Update existing slugs on artifact rows
UPDATE artifacts SET slug = 'PLN' || substring(slug FROM 5) WHERE slug ~ '^PLAN-';

-- Update existing slugs on feature rows (Feature model maps to the "issues" table)
UPDATE issues SET slug = 'FEA' || substring(slug FROM 5) WHERE slug ~ '^FEAT-';

-- Update existing slugs on project rows
UPDATE projects SET slug = 'PRO' || substring(slug FROM 5) WHERE slug ~ '^PROJ-';

-- Rename the slug_counter rows so new slugs continue the existing sequence
UPDATE slug_counters SET type_prefix = 'PLN' WHERE type_prefix = 'PLAN';
UPDATE slug_counters SET type_prefix = 'FEA' WHERE type_prefix = 'FEAT';
UPDATE slug_counters SET type_prefix = 'PRO'  WHERE type_prefix = 'PROJ';
