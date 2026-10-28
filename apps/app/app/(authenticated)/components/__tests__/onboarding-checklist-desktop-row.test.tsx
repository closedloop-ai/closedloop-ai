// @vitest-environment jsdom

import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
  /**
   * Keys PostHog has not answered for yet. `useFeatureFlag` returns `undefined`
   * for those, which is a DIFFERENT input from a settled `false` — it is the
   * anonymous-bootstrap window every reader passes through before `identify()`
   * reloads the signed-in user's assignment, and it is the state ISS-9708 exists
   * to make safe. Held separately from `enabledFlags` because that set answers
   * `false` for anything it does not contain, which silently turns "nobody has
   * decided" into "decided no".
   */
  unresolvedFlags: new Set<string>(),
  status: null as unknown,
  statusOptions: undefined as Record<string, unknown> | undefined,
  dismiss: vi.fn(),
  // Driven explicitly rather than through a stubbed user agent: the detection
  // itself is covered by the hook's and the lib's own suites, and what this file
  // owns is what the ROW does for each answer -- including `null`, which
  // `render` flushes past before an assertion could see it.
  detectedOs: null as string | null,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) =>
    mocks.unresolvedFlags.has(key)
      ? undefined
      : { enabled: mocks.enabledFlags.has(key) },
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: (options?: Record<string, unknown>) => {
    mocks.statusOptions = options;
    return { data: mocks.status };
  },
  useDismissChecklist: () => ({ mutate: mocks.dismiss }),
}));
vi.mock("@repo/app/onboarding/hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => mocks.detectedOs,
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { OnboardingChecklist } from "../onboarding-checklist";

const DOWNLOAD_LABEL = "Download the desktop app";
/**
 * A stand-in for whatever href the API sends, not a copy of the production
 * constant — this suite renders the checklist from a fixture and asserts the
 * href it was handed reaches the anchor intact. The real URL, and the fact that
 * it names no platform, are pinned in `apps/api`'s own service test, which is
 * the side that produces it; `apps/app` cannot import it without reaching across
 * the app boundary. So neither suite proves ISS-9708 alone: `apps/api` proves the
 * target is platform-neutral, this file proves it reaches the reader intact.
 */
const FIXTURE_RELEASE_PAGE_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/tag/desktop-latest";
/**
 * The pre-ISS-9708 payload: one platform's asset URL for every reader. Kept as a
 * fixture because a tab open across the deploy still holds it in the TanStack
 * cache, so the row must render it as a working control rather than depending on
 * a field only the new payload carries.
 */
const LEGACY_FIXTURE_DMG_URL =
  "https://github.com/closedloop-ai/closedloop-ai/releases/download/desktop-latest/Closedloop-universal.dmg";

function item(
  id: ChecklistItemId,
  overrides: Partial<OnboardingChecklistItem> = {}
): OnboardingChecklistItem {
  return {
    id,
    label: id,
    description: `${id} description`,
    completed: false,
    href: "/settings",
    ...overrides,
  };
}

function setStatus(checklist: OnboardingChecklistItem[]) {
  mocks.status = {
    wizardCompleted: true,
    checklistDismissed: false,
    checklist,
  };
}

/** The full set the service returns, in service order. */
function fullChecklist() {
  return [
    item(ChecklistItemId.CreateTeam, { completed: true }),
    item(ChecklistItemId.CreateProject, { completed: true }),
    item(ChecklistItemId.DownloadDesktop, {
      label: DOWNLOAD_LABEL,
      href: FIXTURE_RELEASE_PAGE_URL,
      external: true,
    }),
    item(ChecklistItemId.ConnectGitHub),
    item(ChecklistItemId.ConnectGoogle),
    item(ChecklistItemId.InviteMembers),
  ];
}

describe("OnboardingChecklist — desktop download row", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.unresolvedFlags.clear();
    mocks.statusOptions = undefined;
    mocks.dismiss.mockReset();
    // A published platform, so the platform-honest rewrite is a no-op here and
    // these cases stay about the row's LINK semantics. The rewrite used to be
    // gated and these ran with it closed; it is unconditional now, so the
    // platform has to be stated rather than left at the `null` default.
    mocks.detectedOs = "mac";
    setStatus(fullChecklist());
  });

  it("carries the download the wizard stopped asking for", () => {
    // The wizard step that pointed at the desktop app is deleted, so this row is
    // the product's only remaining entrance to it — it is gated on nothing.
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getByText(DOWNLOAD_LABEL)).toBeTruthy();
    expect(screen.getByText("2 of 5 tasks completed")).toBeTruthy();
  });

  it("leaves the app for the download instead of routing inside the SPA", () => {
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    const link = screen.getByText(DOWNLOAD_LABEL).closest("a");
    expect(link?.getAttribute("href")).toBe(FIXTURE_RELEASE_PAGE_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("warns that the download row leaves the app", () => {
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    // Otherwise this row is byte-identical to the in-app ones, and clicking it
    // opens a new tab and starts a binary download with no warning.
    expect(screen.getByText("(opens in a new tab)")).toBeTruthy();
  });

  it("announces the task count so completing a step is not silent", () => {
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(
      screen.getByText("2 of 5 tasks completed").getAttribute("aria-live")
    ).toBe("polite");
  });

  it("hides the Google row until its own flag is on", () => {
    // Unrelated to ISS-5490 and not this change's to alter: the denominator
    // above is 6 rather than 7 because of it.
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.queryByText(ChecklistItemId.ConnectGoogle)).toBeNull();
  });

  it("re-checks the desktop row on every return to the tab, not only when stale", () => {
    // The row completes outside the browser, so nothing in-tab invalidates the
    // query. `true` would only refetch a STALE query, and this one stays fresh
    // for five minutes — the whole window in which someone installs Desktop and
    // comes back.
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(mocks.statusOptions?.refetchOnWindowFocus).toBe("always");
  });

  it("stops linking the download row once it is complete", () => {
    setStatus(
      fullChecklist().map((entry) =>
        entry.id === ChecklistItemId.DownloadDesktop
          ? { ...entry, completed: true }
          : entry
      )
    );

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getByText(DOWNLOAD_LABEL).closest("a")).toBeNull();
  });
});

/**
 * ISS-9651. The service builds this row where the visitor's platform is not
 * knowable, so it cannot say anything about the machine reading it. What it can
 * still fail to say is that this platform has no installer yet — the row would
 * otherwise read exactly like the ones that work.
 *
 * The expected copy is written out here rather than imported from
 * `describeDesktopInstallerGap`: reading it back from the helper the row calls
 * would pass whatever that helper returns.
 */
const WINDOWS_GAP_LINE = "Not available for Windows yet";

describe("OnboardingChecklist — desktop row on a platform with no installer", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.unresolvedFlags.clear();
    mocks.statusOptions = undefined;
    mocks.dismiss.mockReset();
    mocks.detectedOs = "mac";
    setStatus(fullChecklist());
  });

  it("withholds the download target from Windows and says why", () => {
    mocks.detectedOs = "windows";

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getByText(DOWNLOAD_LABEL).closest("a")).toBeNull();
    expect(screen.getByText(WINDOWS_GAP_LINE)).toBeTruthy();
  });

  it("drops the leaves-the-app affordance with the link it described", () => {
    mocks.detectedOs = "windows";

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.queryByText("(opens in a new tab)")).toBeNull();
  });

  it("keeps the row in the checklist as an incomplete step", () => {
    // The step still exists and is still not done. Removing the row instead
    // would move the denominator and read as "nothing left to install here".
    mocks.detectedOs = "windows";

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getByText(DOWNLOAD_LABEL)).toBeTruthy();
    expect(screen.getByText("2 of 5 tasks completed")).toBeTruthy();
  });

  it("leaves a macOS visitor on the target the service sent", () => {
    // The macOS arm, so this proves the branch keys off the PLATFORM. Without
    // it, unlinking the row for everyone would satisfy the Windows cases above.

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(
      screen.getByText(DOWNLOAD_LABEL).closest("a")?.getAttribute("href")
    ).toBe(FIXTURE_RELEASE_PAGE_URL);
    expect(screen.queryByText(WINDOWS_GAP_LINE)).toBeNull();
  });

  it("offers nothing while the platform is still unknown", () => {
    // Reachable on a warm query cache: the row commits before the detection
    // effect runs. Claiming a gap nobody has measured would be a lie, and this
    // arm declines to make either claim.
    mocks.detectedOs = null;

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.getByText(DOWNLOAD_LABEL).closest("a")).toBeNull();
    expect(screen.queryByText(WINDOWS_GAP_LINE)).toBeNull();
  });
});

/**
 * ISS-9708 AC4. A tab open across the deploy still holds the pre-fix payload in
 * its TanStack cache, and an already-installed client reads the row by the same
 * two fields it always did. Either way the control has to work off `href` and
 * `external` alone, with no new field to fall back to.
 */
describe("OnboardingChecklist — desktop row from a pre-fix payload", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.unresolvedFlags.clear();
    mocks.statusOptions = undefined;
    mocks.dismiss.mockReset();
    // macOS for the same reason as the suite above: what survives here is that
    // the control works off `href` and `external` alone. A Windows reader now
    // reaches the gap arm unconditionally, so it can no longer carry this case.
    mocks.detectedOs = "mac";
    setStatus(fullChecklist());
  });

  it("still renders a working control from the pre-fix single-href payload", () => {
    setStatus(
      fullChecklist().map((entry) =>
        entry.id === ChecklistItemId.DownloadDesktop
          ? { ...entry, href: LEGACY_FIXTURE_DMG_URL }
          : entry
      )
    );

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    const link = screen.getByText(DOWNLOAD_LABEL).closest("a");
    expect(link?.getAttribute("href")).toBe(LEGACY_FIXTURE_DMG_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(screen.getByText("(opens in a new tab)")).toBeTruthy();
  });
});

describe("OnboardingChecklist — desktop row on an unidentified platform", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.unresolvedFlags.clear();
    mocks.statusOptions = undefined;
    mocks.dismiss.mockReset();
    setStatus(fullChecklist());
  });

  it("keeps the download link rather than withholding it", () => {
    // This row is one link and names no platform, so it misroutes nobody the way
    // a "Download Mac Desktop App" button would; withholding it is the
    // capability loss Perrin's ISS-9651 ruling refused. The wizard control is the
    // surface with room to offer one entry per platform, and does.
    mocks.detectedOs = "unrecognized";

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(
      screen.getByText(DOWNLOAD_LABEL).closest("a")?.getAttribute("href")
    ).toBe(FIXTURE_RELEASE_PAGE_URL);
  });

  it("claims no gap for a platform it never identified", () => {
    // The paired control: keeping the link must not slide into also asserting an
    // unavailability, and it must not name a platform nobody measured.
    mocks.detectedOs = "unrecognized";

    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(screen.queryByText(WINDOWS_GAP_LINE)).toBeNull();
  });
});
