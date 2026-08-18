-- FEA-3956 (PRD-560 Phase 3): add the canonical `ISSUE` value to the
-- ArtifactSubtype enum for the Features → Issues rename. Additive and
-- non-destructive: existing rows stay stored as `FEATURE` (PRD-560 decision 2),
-- and the API/wire boundary maps the canonical `ISSUE` input back to `FEATURE`
-- in code (`normalizeArtifactSubtype`). No data migration; `FEATURE` remains a
-- permanent compat alias (removing it is Phase 4 / FEA-3957, human-approved).

-- AlterEnum
ALTER TYPE "ArtifactSubtype" ADD VALUE 'ISSUE';
