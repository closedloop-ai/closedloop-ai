/**
 * ISS-8936 (ISS-4779 closed-by-default policy): gates the summary metric band
 * above the Documents index — four counts over the SAME population the list
 * beneath them describes. Off renders today's index byte for byte: no band, and
 * no `GET /documents/summary` request at all, so the gate costs a closed reader
 * nothing.
 *
 * WEB-ONLY, for the reason its siblings `documents-index-states-flag`,
 * `documents-index-server-search-flag` and `documents-index-paged-flag` are: the
 * desktop shell has no Documents destination. Verified rather than assumed —
 * `documents` appears nowhere as a route, nav item or view under
 * `apps/desktop/src/renderer`.
 *
 * It stays ONE key regardless. The day a desktop Documents destination exists,
 * that renderer reads THIS literal from the signed-in account's PostHog
 * assignment, the same key space `apps/app` reads. There is no second desktop
 * key, no Labs toggle beside it and no registry shadow entry: since ISS-8753
 * `DesktopFeatureFlagProvider` reads the PostHog assignment and nothing else.
 *
 * Declaring the constant creates nothing in PostHog. An unknown key resolves to
 * `false`, the safe direction for a closed-by-default gate.
 */
export const DOCUMENTS_INDEX_SUMMARY_CARDS_FLAG_KEY =
  "documents-index-summary-cards" as const;
