/**
 * @file session-timeline-coverage-disclosure-flag.ts
 * @description Shared key for the closed-by-default Session Timeline coverage
 * disclosure (ISS-7427 acceptance criterion 5, under ISS-4779).
 *
 * The strip is tiled from the session's SYNCED ACTIVITY, and its axis window
 * starts at the first plotted row rather than at `session.startedAt`
 * (`session-timeline-geometry.ts`). So the bars describe the intervals we hold
 * rows for, and every interval outside that window is drawn as nothing at all
 * while every quiet bin inside it is drawn as observed quiet
 * (`isInteriorGap`/`.idle`, "Nothing recorded in this slice").
 *
 * On a session whose main transcript is terminally absent that reading is wrong
 * in one direction that matters: the archive that would have measured the rest
 * is never arriving, so the uncovered time is UNKNOWN rather than idle, and the
 * strip as drawn implies a completeness it does not have. The existing
 * `measured` / `unread` / `synthesized` vocabulary already names truncation and
 * synthesis; it is keyed to neither transcript availability nor evidence
 * coverage, which is the gap this gate covers.
 *
 * IT ALSO GATES AC4's METRIC PROVENANCE, and the key string is now narrower than
 * what it covers. The Properties panel's Cost, Tokens and Duration rows carry
 * the same disclosure about the same `metadataOnly` response on the same screen
 * — where a figure came from, in the one state where nothing will ever reconcile
 * it against an archive. Splitting them onto a second key would let an operator
 * caption the strip while the three numbers beside it stayed bare, which is the
 * ISS-6462 shape: two elements of one screen contradicting each other about one
 * response. The KEY STRING is deliberately left alone — `labs-setting-key-ledger`
 * pins it and renaming it is a settings migration, not a copy change — so the
 * human-readable label and description carry the widened meaning instead.
 *
 * STILL DISTINCT FROM `session-trace-evidence-disclosure`. That gate makes a
 * claim about a COUNT's provenance in the Session Trace heading and shipped on
 * its own toggle in #5686; this one covers the timeline's SPAN and the
 * Properties panel's FIGURES.
 *
 * Both surfaces mount the timeline AND `SessionPropertiesPanel` through the
 * shared `AgentSessionDetailView`, so the gate must exist on both or the
 * disclosure leaks on the ungated one. Both surfaces read it as a PostHog flag
 * — the desktop renderer resolves the signed-in account's PostHog assignment
 * from the same key space `apps/app` reads — and both alias THIS constant so
 * the two strings cannot drift. It lives in `@repo/api` because that is the
 * only dependency-free module both surfaces can import.
 */
export const SESSION_TIMELINE_COVERAGE_DISCLOSURE_FLAG_KEY =
  "session-timeline-coverage-disclosure" as const;
