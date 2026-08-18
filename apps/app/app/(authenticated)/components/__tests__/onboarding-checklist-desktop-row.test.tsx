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
  status: null as unknown,
  statusOptions: undefined as Record<string, unknown> | undefined,
  dismiss: vi.fn(),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => ({ enabled: mocks.enabledFlags.has(key) }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: (options?: Record<string, unknown>) => {
    mocks.statusOptions = options;
    return { data: mocks.status };
  },
  useDismissChecklist: () => ({ mutate: mocks.dismiss }),
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

import { OnboardingChecklist } from "../onboarding-checklist";

const DOWNLOAD_LABEL = "Download the desktop app";
/**
 * A stand-in for whatever href the API sends, not a copy of the production
 * constant — this suite renders the checklist from a fixture and asserts the
 * href it was handed reaches the anchor intact. The real URL is pinned in
 * `apps/api`'s own service test, which is the side that produces it; `apps/app`
 * cannot import it without reaching across the app boundary.
 */
const FIXTURE_DMG_URL =
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
      href: FIXTURE_DMG_URL,
      external: true,
    }),
    item(ChecklistItemId.ConnectGitHub),
    item(ChecklistItemId.AddAnthropicKey),
    item(ChecklistItemId.ConnectGoogle),
    item(ChecklistItemId.InviteMembers),
  ];
}

describe("OnboardingChecklist — desktop download row", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.statusOptions = undefined;
    mocks.dismiss.mockReset();
    setStatus(fullChecklist());
  });

  it("carries the download the wizard stopped asking for", () => {
    // The wizard step that pointed at the desktop app is deleted, so this row is
    // the product's only remaining entrance to it — it is gated on nothing.
    render(<OnboardingChecklist />);

    expect(screen.getByText(DOWNLOAD_LABEL)).toBeTruthy();
    expect(screen.getByText("2 of 6 tasks completed")).toBeTruthy();
  });

  it("leaves the app for the download instead of routing inside the SPA", () => {
    render(<OnboardingChecklist />);

    const link = screen.getByText(DOWNLOAD_LABEL).closest("a");
    expect(link?.getAttribute("href")).toBe(FIXTURE_DMG_URL);
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("warns that the download row leaves the app", () => {
    render(<OnboardingChecklist />);

    // Otherwise this row is byte-identical to the in-app ones, and clicking it
    // opens a new tab and starts a binary download with no warning.
    expect(screen.getByText("(opens in a new tab)")).toBeTruthy();
  });

  it("announces the task count so completing a step is not silent", () => {
    render(<OnboardingChecklist />);

    expect(
      screen.getByText("2 of 6 tasks completed").getAttribute("aria-live")
    ).toBe("polite");
  });

  it("hides the Google row until its own flag is on", () => {
    // Unrelated to ISS-5490 and not this change's to alter: the denominator
    // above is 6 rather than 7 because of it.
    render(<OnboardingChecklist />);

    expect(screen.queryByText(ChecklistItemId.ConnectGoogle)).toBeNull();
  });

  it("re-checks the desktop row on every return to the tab, not only when stale", () => {
    // The row completes outside the browser, so nothing in-tab invalidates the
    // query. `true` would only refetch a STALE query, and this one stays fresh
    // for five minutes — the whole window in which someone installs Desktop and
    // comes back.
    render(<OnboardingChecklist />);

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

    render(<OnboardingChecklist />);

    expect(screen.getByText(DOWNLOAD_LABEL).closest("a")).toBeNull();
  });
});
