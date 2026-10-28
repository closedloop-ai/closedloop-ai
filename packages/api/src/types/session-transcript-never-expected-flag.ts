/**
 * ISS-7516 — the shared web+desktop UI flag key for the session-detail
 * transcript panel's NEVER-EXPECTED absence state.
 *
 * A device on the `metadata` sync-observability tier never queues a transcript
 * at all (`syncTierAllowsTranscripts` admits only `full`), so its sessions land
 * in the panel's `missing` state permanently and are told the source machine
 * will upload one. It will not. This flag gates the distinct wording for that
 * settled absence; the not-yet-arrived wording is unchanged and still renders
 * for every session whose transcript genuinely is still on its way.
 *
 * Its own leaf module, dependency-free, for the reason the sibling flag leaves
 * are: `apps/desktop`'s main-process Labs registry and the `apps/app` PostHog
 * alias both import this constant, and neither may pull the other's transitive
 * graph in to get it. One constant, two aliases, so the two surfaces cannot
 * drift into gating on different strings.
 */
export const SESSION_TRANSCRIPT_NEVER_EXPECTED_FLAG_KEY =
  "session-transcript-never-expected" as const;
