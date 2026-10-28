-- The four column-valued facet dimensions plus the linked-document Project
-- facet, as WHERE conjuncts.
--
-- NOT spliced into sessionFacetCounts. That statement needs each dimension as a
-- NAMED BOOLEAN rather than a conjunct, because a facet's own counts must be
-- computed with its own selection RELAXED and every other selection applied —
-- cross-filtering. Splicing these there would filter the owner counts by the
-- owner selection, which reduces every unselected owner to zero and makes the
-- facet unusable for widening a search. Its flags carry the same column-to-
-- parameter pairing and `check:typed-sql-fragments` asserts that pairing.
-- ISS-12251 (PLN-2176 D-1): the Owner facet is the session artifact's assignee,
-- not `session_detail.user_id`.
AND (cardinality($4::uuid[]) = 0 OR a.assignee_id = ANY($4::uuid[]))
AND (cardinality($6::text[]) = 0 OR sd.repository_full_name = ANY($6::text[]))
AND (cardinality($7::text[]) = 0 OR sd.harness = ANY($7::text[]))
AND (cardinality($8::text[]) = 0 OR sd.model = ANY($8::text[]))
-- ISS-5355: the Project facet is the session->document link, NOT
-- `artifacts.project_id`. Session artifacts are normally unparented, so keying
-- on the column would exclude every ordinary session.
--
-- ISS-9903: BOTH sides of this reach carry the organisation predicate. The
-- driving `session_detail` row is already org-scoped by the statement's own
-- WHERE, but this walks a LINK to a SECOND artifact, and neither the link nor
-- that artifact was constrained. `sessionMergedPrLoc.sql` re-asserts org on
-- every table it reaches through a link (`p.organization_id = $1::uuid` on the
-- joined `pull_request_detail`); this dimension was the one that did not, and
-- the convention is worth more than the redundancy.
--
-- It was only ever safe because `artifactLinksService.createLink` asserts both
-- endpoints of a RELATES_TO link share an org. That is a property of SOME write
-- paths, not of the schema — `documents/document-service.ts` creates an
-- ArtifactLink from a caller-supplied `sourceId` with no org check on it — so
-- the read side should not depend on it. A cross-org link would otherwise pull
-- another tenant's `project_id` into this org's Project facet.
--
-- BOTH PREDICATES ARE COVERED, and each guards a different shape:
--
--   `pd.organization_id` catches a link stamped with the CALLER's org whose
--   target document belongs to another — what a writer that stamps from its
--   source and never validates its target produces. A confidentiality leak:
--   another tenant's project_id enters this org's facet.
--
--   `pl.organization_id` catches the mirror — a document that IS this org's,
--   reached by a link row owned by another. Not confidentiality (the project is
--   ours) but INTEGRITY: another tenant could otherwise place a project into
--   this org's facet by writing a link this org never created.
--
-- An earlier revision of this comment called the second one "defence in depth
-- with no isolating fixture". That was wrong — the mirror shape isolates it
-- perfectly well, and `usage-typed-sql-statements.integration.test.ts` now
-- seeds both. Deleting either line fails that case (whitlockk on #6967).
AND (
  cardinality($9::uuid[]) = 0
  OR EXISTS (
    SELECT 1
    FROM artifact_links pl
    JOIN artifacts pd
      ON pd.id = pl.target_id
     AND pd.organization_id = $1::uuid
    WHERE pl.source_id = sd.artifact_id
      AND pl.organization_id = $1::uuid
      AND pl.link_type = 'RELATES_TO'
      AND pd.type = 'DOCUMENT'
      AND pd.project_id = ANY($9::uuid[])
  )
)
