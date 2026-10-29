/**
 * ISS-5850: the single cross-surface flag key gating the Session Timeline's
 * UNMEASURED-INTERVAL disclosure.
 *
 * WHAT IT GATES. The strip draws a fixed 24-column clock window, but the bins it
 * draws from tile the collector's own activity extent, which is routinely a
 * strict subset of that window — 82.6% of it on average across 2,591 real local
 * sessions, and under half of it on 12.4% of them. Columns beyond that coverage
 * are emitted with every field at zero, and zero currently renders exactly like
 * an observed quiet stretch: a hatched bar and a tooltip reading "Agent asleep |
 * scheduled wake-up | no tokens billed". That is a measured claim about an
 * interval nobody measured.
 *
 * When ON, a column the producer's stated extent does not reach stops making
 * that claim. When OFF — and on any session whose producer never stated an
 * extent — every column behaves exactly as it did before, which is what makes
 * the desktop-side rollout skew-safe on its own.
 *
 * SIBLING, NOT DUPLICATE, of `session-timeline-synthesized-cost` (ISS-5566).
 * That key answers "was this money measured at all"; this one answers "was this
 * INTERVAL measured at all". A session can be either, both, or neither — a
 * measured strip still has unmeasured intervals around its extent — so folding
 * them into one key would make an honest strip depend on an unrelated toggle.
 *
 * Deliberately NOT a warning tone (ISS-5842): an unmeasured interval is a fact
 * about how the collector binned the run, not a fault the reader can act on.
 *
 * Lives in this lightweight, dependency-free `@repo/api` module (no Zod, no
 * heavy transitive graph) so both surfaces import the SAME literal instead of
 * redeclaring it — the ISS-5841 arrangement, where byte-equality is a fact of
 * the import rather than a comment two files must keep agreeing on:
 *  - the web app resolves it per-viewer through PostHog, via
 *    `SESSION_TIMELINE_SOURCE_EXTENT_FEATURE_FLAG_KEY`
 *    (`packages/app/shared/lib/feature-flags.ts`);
 *  - the desktop renderer resolves THAT SAME literal from the signed-in
 *    account's PostHog assignment — the same key space the web app reads — so
 *    the two surfaces cannot diverge. The constant is imported directly into
 *    `SHARED_UI_FEATURE_FLAGS`
 *    (`apps/desktop/src/shared/feature-flags-shared-ui.ts`), which owns the
 *    desktop default-off settings metadata rather than the renderer's read.
 *    No `DESKTOP_…` alias is minted for it: the older keys here have one for
 *    historical reasons, and a second name would be one more thing that can
 *    drift from this literal.
 *
 * `AgentSessionDetailView` mounts on BOTH surfaces, so both reading THIS
 * literal means a rename cannot silently split the two surfaces' reads of it
 * and leave the disclosure visible on one surface and hidden on the other.
 * Default OFF on both (ISS-4779 closed-by-default).
 */
export const SESSION_TIMELINE_SOURCE_EXTENT_FLAG_KEY =
  "session-timeline-source-extent" as const;
