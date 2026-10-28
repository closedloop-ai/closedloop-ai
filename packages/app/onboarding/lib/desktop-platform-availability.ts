/**
 * Which desktop platforms actually have a published installer, what to call each
 * one on screen, and how to say the gap out loud (ISS-9651, PRD-685 FR11).
 *
 * SSOT for every download surface. Four of them exist and they must not
 * disagree: the setup-checklist row in `apps/app`, the wizard step in this
 * package, the web dashboard's zero-session empty state (ISS-11261, which renders
 * that step's own composite rather than a second reading of this module), and the
 * workspace menu's Download desktop app entry (ISS-9682).
 * Before this module each hardcoded the macOS installer for every visitor, so a
 * Windows or Linux user was handed a `.dmg` that cannot run there. ISS-9708 took
 * the checklist row off that footing for good — its payload is now the channel's
 * platform-neutral release page — so on that surface this module supplies the
 * SENTENCE about the gap rather than the correction of a wrong artifact. The
 * wizard step and the menu entry still resolve a per-platform asset, so for them
 * the original job stands.
 *
 * Deliberately React-free and design-system-free. Every consumer is a
 * `"use client"` module the shell mounts on first paint, and one of them is a
 * hook, so the values have to be importable without dragging a component in.
 *
 * {@link DesktopOs} and {@link detectDesktopOs} live here rather than beside the
 * wizard step that used to own them: they are what ALL THREE surfaces key off,
 * and a checklist hook importing a modal step for its platform enum is the shape
 * the repo guidelines call out.
 */

import {
  DESKTOP_LATEST_DMG_URL,
  DESKTOP_LATEST_LINUX_APPIMAGE_URL,
} from "@repo/api/src/types/desktop-download";

export const DesktopOs = {
  Linux: "linux",
  Mac: "mac",
  Windows: "windows",
} as const;

export type DesktopOs = (typeof DesktopOs)[keyof typeof DesktopOs];

export type DesktopDownloadHrefs = Readonly<Record<DesktopOs, string | null>>;

/**
 * The truth state of one platform's installer.
 *
 * `NotYetPublished` is not "unsupported" and not "failed": Windows is a
 * shipping target (PRD-685) whose artifact does not exist yet. The
 * distinction is the point of this module, so it is a named state rather than an
 * absent entry a render would have to interpret.
 */
export const DesktopInstallerAvailability = {
  Published: "published",
  NotYetPublished: "not_yet_published",
} as const;

export type DesktopInstallerAvailability =
  (typeof DesktopInstallerAvailability)[keyof typeof DesktopInstallerAvailability];

/**
 * Keyed exhaustively on {@link DesktopOs} rather than held as a set of published
 * platforms: a set widens to `string`, so a new platform would compile, miss the
 * set, and silently take whichever arm absence selects. A missing key here fails
 * `tsc`.
 */
export const DESKTOP_INSTALLER_AVAILABILITY: Readonly<
  Record<DesktopOs, DesktopInstallerAvailability>
> = {
  // ISS-12614: every desktop release publishes the Linux AppImage beside the DMG.
  [DesktopOs.Linux]: DesktopInstallerAvailability.Published,
  [DesktopOs.Mac]: DesktopInstallerAvailability.Published,
  // PRD-685. `electron-builder.yml` still declares only a `mac:` block, so the
  // release carries no Windows asset for a download control to point at. Flip
  // this to `Published` in the change that lands the artifact (ISS-9637 defines
  // the installer contract, ISS-9643 publishes it), not before.
  [DesktopOs.Windows]: DesktopInstallerAvailability.NotYetPublished,
};

/**
 * What a detection can report: one of the {@link DesktopOs} members, or that it
 * could not tell.
 *
 * `Unrecognized` deliberately sits OUTSIDE {@link DesktopOs} rather than joining
 * it. `DesktopOs` is the set of platforms an installer can be published FOR, and
 * every exhaustive record in this module is keyed on it -- "is the Unrecognized
 * installer published" is not a question with an answer, and giving it a slot
 * would force one. This union is the wider thing detection speaks; the records
 * stay narrow, so adding a real platform still fails `tsc` in every one of them.
 *
 * It is also NOT the same state as the `null` {@link useDetectedDesktopOs}
 * answers before its effect runs. `null` is "nobody has looked yet";
 * `Unrecognized` is "we looked and this agent names no desktop OS". A surface
 * that conflates them either withholds a download it could have offered or
 * claims a measurement it never made.
 */
export const DetectedPlatform = {
  ...DesktopOs,
  Unrecognized: "unrecognized",
} as const;

export type DetectedPlatform =
  (typeof DetectedPlatform)[keyof typeof DetectedPlatform];

export const DESKTOP_OS_LABEL: Readonly<Record<DesktopOs, string>> = {
  [DesktopOs.Linux]: "Linux",
  [DesktopOs.Mac]: "macOS",
  [DesktopOs.Windows]: "Windows",
};

/**
 * The predicate is DERIVED from an exhaustive record rather than written as
 * `=== Published`, so a third availability state cannot quietly resolve to
 * "not published" and take the honest arm by accident.
 */
const DESKTOP_INSTALLER_AVAILABILITY_RESOLVES: Readonly<
  Record<DesktopInstallerAvailability, boolean>
> = {
  [DesktopInstallerAvailability.NotYetPublished]: false,
  [DesktopInstallerAvailability.Published]: true,
};

export const DESKTOP_OS_VALUES: readonly DesktopOs[] = Object.values(DesktopOs);

/**
 * Whether a detection landed on a platform an installer can exist for.
 *
 * Derived by membership of the availability record, not written as
 * `!== Unrecognized`: an exclusion test is a side inventory of one, and a second
 * non-platform state would silently narrow to {@link DesktopOs} through it. A
 * new platform joins this the moment it gets its required record entry.
 */
export function isDesktopOs(platform: DetectedPlatform): platform is DesktopOs {
  return Object.hasOwn(DESKTOP_INSTALLER_AVAILABILITY, platform);
}

/** Whether a download control for this platform has anything to point at. */
export function desktopInstallerIsPublished(os: DesktopOs): boolean {
  return DESKTOP_INSTALLER_AVAILABILITY_RESOLVES[
    DESKTOP_INSTALLER_AVAILABILITY[os]
  ];
}

/**
 * What to say instead of offering a download.
 *
 * One helper produces both lines so the compact checklist row and the roomier
 * wizard alert cannot drift into describing the same state differently. The
 * platforms that DO resolve are read back out of the map instead of spelled into
 * the sentence, so the copy follows the artifacts rather than going stale the
 * day a second platform ships.
 */
export function describeDesktopInstallerGap(os: DesktopOs): {
  readonly headline: string;
  readonly detail: string;
} {
  const label = DESKTOP_OS_LABEL[os];
  // At most two names: `os` itself is unpublished in every branch that reaches
  // here, so `join(" and ")` is exact for the whole remaining set.
  const publishedLabels = DESKTOP_OS_VALUES.filter(
    desktopInstallerIsPublished
  ).map((published) => DESKTOP_OS_LABEL[published]);
  const alternative =
    publishedLabels.length > 0
      ? ` Closedloop Desktop installs on ${publishedLabels.join(" and ")} today.`
      : "";

  return {
    headline: `Not available for ${label} yet`,
    detail: `There is no ${label} installer to download yet.${alternative}`,
  };
}

/**
 * Best-effort platform read. An agent this cannot parse gets
 * {@link DetectedPlatform.Unrecognized}, NOT a guess.
 *
 * It used to answer macOS here, which put the `.dmg` back in play for Chrome OS
 * and anything else that names no desktop OS. Withholding the download instead
 * was the obvious correction and the wrong one: it also strips the installer
 * from a Mac whose agent this cannot read. Perrin's call on the ISS-9651 review
 * (2026-09-07) was neither -- report the honest "I could not tell" and let the
 * control offer every platform, so nobody is misrouted and nobody loses a path.
 */
export function detectDesktopOs(): DetectedPlatform {
  if (typeof navigator === "undefined") {
    return DetectedPlatform.Unrecognized;
  }

  const browserNavigator = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  const platform = (
    browserNavigator.userAgentData?.platform ||
    browserNavigator.platform ||
    browserNavigator.userAgent
  ).toLowerCase();

  // macOS is tested FIRST and by name. `"win"` is a substring of `"darwin"`, so
  // an agent string carrying the kernel name rather than the marketing one read
  // as Windows — harmless while the only consequence was a button label, and not
  // harmless now that it withholds the download a Mac can actually use.
  if (platform.includes("mac") || platform.includes("darwin")) {
    return DesktopOs.Mac;
  }
  if (platform.includes("win")) {
    return DesktopOs.Windows;
  }
  if (platform.includes("linux")) {
    return DesktopOs.Linux;
  }
  return DetectedPlatform.Unrecognized;
}

/**
 * The per-platform installer payload every host offers by default (ISS-11261
 * review: whitlockk, chatgpt-codex-connector).
 *
 * ONE MAP, because two surfaces now make this offer — the guided-onboarding
 * wizard's host and the web dashboard's zero-session empty state — and a second
 * copy of it goes stale silently rather than loudly: the day the Windows
 * artifact is published, whoever flips {@link DESKTOP_INSTALLER_AVAILABILITY}
 * and the wizard's own map leaves the other surface still telling its reader
 * there is no installer.
 *
 * Held here rather than derived from {@link DESKTOP_INSTALLER_AVAILABILITY},
 * because a URL cannot be computed from an enum — but the two are pinned to each
 * other in both directions by `desktop-platform-availability.test.ts`, so a
 * platform flipped to `Published` with no URL here, or given a URL while still
 * recorded as unpublished, fails `pnpm test` instead of shipping two answers.
 */
export const DEFAULT_DESKTOP_DOWNLOAD_HREFS = {
  [DesktopOs.Linux]: DESKTOP_LATEST_LINUX_APPIMAGE_URL,
  [DesktopOs.Mac]: DESKTOP_LATEST_DMG_URL,
  [DesktopOs.Windows]: null,
} satisfies DesktopDownloadHrefs;
