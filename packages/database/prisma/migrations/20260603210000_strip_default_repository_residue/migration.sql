-- FEA-1058 hygiene: clear any defaultRepository residue from project settings.
-- Pure cleanup — this PR deletes the reader, so a residual key is already inert.
UPDATE "projects" p SET "settings" = "settings" - 'defaultRepository'
WHERE "settings" ? 'defaultRepository';
