/**
 * ISS-10961: the single cross-surface flag key gating how a guided-onboarding
 * source row presents a RATIO it cannot form.
 *
 * WHAT IT GATES. One row state, on the "Session discovery" step: a detected
 * source whose analyzed count does not fit its found count (68 found, 72
 * analyzed on the reported install). ISS-10582 settled what that row may CLAIM
 * — both counts are real reads and both stay, only the quotient between them is
 * withheld — and this key changes nothing about that. What it gates is whether
 * the row SAYS SO. With the flag off the row states the two counts beside a
 * held hatch and never names the withholding, so the only thing separating it
 * from a source still being measured is the travelling sheen that a sibling row
 * carries and this one does not. On, the row also:
 *  - names the shortfall in the status text it already renders
 *    ("Percentage unavailable", the `RATIO_UNAVAILABLE_LABEL` constant in
 *    `packages/app/onboarding/components/guided-onboarding-analysis-step.tsx` —
 *    named here in prose because this module cannot import from `@repo/app`);
 *  - takes the settled "nothing to state here" glyph rather than the filled dot
 *    that means a detected source still being read;
 *  - calls its bar "<source> percentage unavailable" in the accessibility tree
 *    instead of "<source> import progress" — or "<source> analyzed count
 *    unavailable" when it is the COUNT that was withheld, so the bar names the
 *    same shortfall the row's own words do.
 * OFF is byte-identical to what shipped in desktop 0.17.133.
 *
 * WHY THE MOTION WAS NOT ENOUGH ON ITS OWN. A sheen is an animation and a hatch
 * is a texture, and neither is a statement: `prefers-reduced-motion` removes
 * the sheen outright, which left the two states pixel-identical for the one
 * reader who opted out of motion, and no screen reader ever had the distinction
 * at all because both bars answered to the same name. Encoding the difference
 * in the accessible name and in the row's own words is what WCAG 1.4.1 asks for
 * here; the glyph is the sighted half of the same statement, by shape rather
 * than by hue.
 *
 * ONE KEY, BOTH SHELLS. The step mounts from `packages/app` on the desktop
 * renderer and on the web shell alike, so the same literal is the whole gate:
 * the desktop renderer resolves the signed-in account's PostHog assignment from
 * the key space the web app reads, with no Labs toggle and no desktop registry
 * entry beside it (the ISS-8024 cutover key is retired). Default OFF on both
 * (ISS-4779 closed-by-default).
 *
 * Lives in this lightweight, dependency-free `@repo/api` module so every
 * consumer imports the SAME literal rather than redeclaring it.
 */
export const ONBOARDING_SOURCE_RATIO_UNAVAILABLE_FLAG_KEY =
  "onboarding-source-ratio-unavailable" as const;
