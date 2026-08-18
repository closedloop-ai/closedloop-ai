/**
 * @file window-labels.ts
 * @description One name per usage window, for both places that draw one.
 *
 * The sidebar summary and the detail drawer render the same windows one click
 * apart, and they were naming them independently: a subset-plan sidebar said
 * "Sonnet week" while the drawer a second later said "Current week, Sonnet".
 * Same window, two names, both on screen at once — the reader has to work out
 * whether they are looking at one figure or two.
 *
 * So the canonical name lives here and both surfaces read it.
 */

/**
 * The full name of each window, used verbatim in the detail drawer.
 *
 * The week windows lead with "Current week" so the three of them sort and scan
 * as one family; naming the model last is what makes "all models", "Sonnet" and
 * "Opus" read as variants of one thing rather than as three unrelated rows.
 */
export const SessionLimitWindowLabel = {
  FiveHour: "Current session (5 hours)",
  SevenDay: "Current week, all models",
  SevenDaySonnet: "Current week, Sonnet",
  SevenDayOpus: "Current week, Opus",
  ExtraUsage: "Extra usage",
} as const;

export type SessionLimitWindowLabel =
  (typeof SessionLimitWindowLabel)[keyof typeof SessionLimitWindowLabel];

/**
 * Sidebar shortenings, for the two windows whose full name carries a qualifier
 * that only earns its width in the drawer. The column is ~14rem, so "(5 hours)"
 * and ", all models" would truncate away exactly the part a reader can already
 * infer from the two bars sitting together.
 *
 * A window absent from this map deliberately has no short form and uses its
 * canonical label in both places: the per-model weeks only ever appear in the
 * sidebar when they are the ONLY window a plan exposes, where there is no
 * sibling bar to infer the model from and shortening would be renaming.
 */
export const SessionLimitWindowShortLabel = {
  FiveHour: "Current session",
  SevenDay: "Current week",
} as const;

export type SessionLimitWindowShortLabel =
  (typeof SessionLimitWindowShortLabel)[keyof typeof SessionLimitWindowShortLabel];
