/**
 * ISS-8597 (PRD-699 §5 D2; ISS-4779 closed-by-default policy): gates the
 * trace-comment dead letter at its SOURCE — the terminal `sync_abandoned` write,
 * and so everything downstream of it. Default OFF, and an unresolved assignment
 * is also OFF — and today there is no flag to resolve at all, which is a
 * stronger statement than "off": read NOT LIVE YET at the foot of this block
 * before concluding anything about what a user can reach.
 *
 * IT DOES NOT GATE THE FAILED BADGE OR THE RETRY DOOR. Those are keyed on the
 * row's own `syncAbandoned`, which only this gated write can set — so they are
 * closed by construction while the key has never been opened, and they stay
 * REACHABLE for a row that is already dead-lettered. See below for why that
 * asymmetry is the whole point.
 *
 * OFF IS TODAY'S BEHAVIOUR, WHOLE, ON A KEY THAT HAS NEVER BEEN OPENED. No row
 * reaches `Abandoned`, so nothing is removed from the drain and a rejected
 * comment keeps retrying exactly as it does now; the ITEM budget is not charged
 * either, so first opening the key starts every row on a full allowance rather
 * than dead-lettering a backlog at the moment of rollout. ON is the whole
 * feature at once.
 *
 * A ROLLBACK STOPS NEW DEAD LETTERS; IT DOES NOT UNDO OLD ONES. Rows abandoned
 * while the key was open stay abandoned when it closes — nothing un-abandons
 * them — so they stay out of the drain until their author retries. What they do
 * NOT lose is the way to do that: the rail reads no key, so the failed badge and
 * the retry door are keyed on the row's own state and survive the rollback. That
 * is the operator's 2026-09-16 ruling in full, and the reason the rail's own read
 * of this key was removed rather than kept as a second gate — two independent
 * readers of one verdict can disagree, and a renderer whose assignment fetch
 * fails settles CLOSED, which would have hidden the door exactly when the lane is
 * failing.
 *
 * That pairing is the point, and it is an operator ruling (2026-09-16) that
 * REPLACES this key's first shape. It originally gated only the perceivable
 * half while the terminal write shipped unconditionally — which, with the key
 * closed, gave a comment a terminal state, took it out of every drain
 * permanently, and showed its author an ordinary card with no retry button.
 * `apps/desktop/src/main/sync/AGENTS.md` invariant 5 names exactly that: a
 * terminal state with no reachable door. A continuing re-POST storm while the
 * key is closed is the accepted cost of the alternative.
 *
 * DECLARED HERE, not in `packages/app/shared/lib/feature-flags.ts`, for the
 * reason that file gives for every other cross-process key: those modules exist
 * so a process outside `packages/app` can spell the same key. Its only runtime
 * reader is in desktop builds older than ISS-11213 — their MAIN process, through
 * the assignment it already fetches (`isDesktopMainFeatureFlagEnabled`), because
 * the abandon write happens on main's sync lane where no React hook can run. Those
 * builds read it twice, by the drain that writes the terminal status and by the
 * burn-down reporter that decides whether the lane's dead-letter count is a
 * measurement or a structural zero. ISS-11213 deleted that lane, so nothing in
 * this tree reads the key; it stays declared for those installed builds.
 *
 * THE `packages/app` RE-EXPORT IS LOAD-BEARING — do not delete it as unused.
 * `scanFlagKeys` only collects constants whose exported name ends in
 * `_FEATURE_FLAG_KEY`, and the constant HERE is `…_FLAG_KEY`, so this module is
 * invisible to it even though `packages/api/src` is one of its roots. The
 * re-export `TRACE_COMMENT_SYNC_ABANDONED_FEATURE_FLAG_KEY` is the ONLY path by
 * which this key reaches the PostHog registration scan and its attestation
 * ledger; removing it drops the key out of that coverage silently. Verified by
 * running the scanner, not inferred — it reports exactly one declaration site,
 * and that site is the re-export. Two specs spell the key through it as well.
 *
 * THAT SINGLENESS IS DELIBERATE. The rail used to read it too, and two
 * independent readers of one verdict can disagree: main re-resolves only on an
 * account boundary while a renderer's read settles CLOSED the moment its fetch
 * fails. The renderer read was removed by the same ruling, so there is now
 * exactly one place a wrong answer can come from. In those older builds the
 * verdict main resolves travels on to the db-host utilityProcess as an ordinary
 * store-op argument, beside the `rowAttributable` flag that already crossed that
 * way.
 *
 * ONE key, never a second desktop-named one and never a Labs toggle beside it —
 * Labs toggles are retired by the 2026-08-30 operator directive.
 *
 * THE FLAG EXISTS, AND ISS-10531 SAID OTHERWISE BECAUSE IT WAS WRONG. This
 * block used to open "NOT LIVE YET, AND THAT IS A DECISION RATHER THAN AN
 * OVERSIGHT (ISS-10531, operator ruling 2026-09-17)" and state that no PostHog
 * flag carried the key, that the flag stayed uncreated, and that the key could
 * not be opened at all. Every clause of that is false. The flag's own PostHog
 * record says it was created on 2026-09-16T21:30:26Z by
 * marisol.ashgrove@closedloop.ai — the day BEFORE ISS-10531 recorded it absent —
 * and it is `active`, at 100% rollout behind a property filter. Confirmed
 * through the PostHog management API against project 341818 on 2026-09-24, and
 * `POSTHOG_FLAG_REGISTRATION_LEDGER` carries that date.
 *
 * SO "DEFAULT OFF" HERE MEANS WHAT IT MEANS EVERYWHERE ELSE: dark for a reader
 * the flag does not select, openable for one it does. It is NOT the stronger
 * "cannot be opened at all, because there is nothing to open" the superseded
 * text claimed. For a reader the property filter selects, the terminal write is
 * LIVE: that row's `syncAbandoned` gets set, a rejected trace comment stops
 * retrying and reaches the dead letter, and the failed badge and retry door —
 * which the rail keys on that field alone, never on this key — are reachable.
 * Any "default OFF" sentence about this key elsewhere in the tree points here;
 * read it in that weaker sense.
 *
 * NO PENDING MARKER. `[ui-flag:gated] trace-comment-sync-abandoned
 * (flag-pending)` was required while this block claimed the flag did not exist.
 * It does exist, so a PR attesting this key states it plainly and
 * `ui-flag-posthog-existence.yml` resolves it. `ATTESTATION_GRACE_DAYS` and the
 * standing `absent-from-posthog` finding that ruling predicted do not apply to
 * this key and never could have.
 *
 * DISTRUST THE CLAIM, NOT JUST ITS DATE. ISS-10531's finding was not overtaken
 * by events; it was incorrect at the moment it was recorded. Anything derived
 * from it about this key is suspect on the same grounds.
 */
export const TRACE_COMMENT_SYNC_ABANDONED_FLAG_KEY =
  "trace-comment-sync-abandoned" as const;
