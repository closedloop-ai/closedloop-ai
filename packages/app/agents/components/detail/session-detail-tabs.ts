/**
 * @file session-detail-tabs.ts
 * @description ISS-10737: the session detail surface's top-level tab vocabulary.
 *
 * `overview` IS TODAY'S PAGE. Introducing a tab bar changes the existing
 * content's home, so the default tab is the single scrolling document the
 * surface has always been — title, properties, timeline, transcript — and an
 * existing deep link into a session, which carries no `?tab=`, still lands
 * exactly where it did. `useTabParam` omits the default from the URL, so those
 * links also stay byte-identical when they are copied back out.
 *
 * The literals are the `?tab=` values, so they are the contract a pasted link
 * speaks and belong in one place rather than at each trigger.
 */
export const SessionDetailTab = {
  Overview: "overview",
  Trace: "trace",
} as const;
export type SessionDetailTab =
  (typeof SessionDetailTab)[keyof typeof SessionDetailTab];

/**
 * The tabs that render when the Trace flag is OFF.
 *
 * `useTabParam`'s own contract asks adopters to build `validTabs` from only the
 * tabs actually rendered when they are flag-gated, so a `?tab=trace` link opened
 * by an account the flag is off for resolves to the default rather than
 * selecting a tab that is not there — a defined landing, not a blank pane.
 */
export const SESSION_DETAIL_TABS_WITHOUT_TRACE: readonly SessionDetailTab[] = [
  SessionDetailTab.Overview,
];

export const SESSION_DETAIL_TABS_WITH_TRACE: readonly SessionDetailTab[] = [
  SessionDetailTab.Overview,
  SessionDetailTab.Trace,
];
