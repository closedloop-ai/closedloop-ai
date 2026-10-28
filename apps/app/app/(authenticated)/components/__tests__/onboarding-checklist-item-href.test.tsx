// @vitest-environment jsdom

import {
  ChecklistItemId,
  type OnboardingChecklistItem,
} from "@repo/api/src/types/onboarding";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  status: null as unknown,
  dismiss: vi.fn(),
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: () => ({ enabled: false }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => ({ data: mocks.status }),
  useDismissChecklist: () => ({ mutate: mocks.dismiss }),
}));
// A published platform, so the platform-honest desktop-row rewrite is a no-op
// and this suite stays about href transformation. The rewrite used to be gated
// and this file ran with the gate closed; it is unconditional now.
vi.mock("@repo/app/onboarding/hooks/use-detected-desktop-os", () => ({
  useDetectedDesktopOs: () => "mac",
}));
vi.mock("@repo/navigation/link", () => ({
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
// The org slug drives the shared `useOrgPath` shim in vitest.setup.ts, which
// mirrors the web adapter — so this suite exercises the real port wiring rather
// than a bespoke builder of its own.
vi.mock("next/navigation", () => ({
  useParams: () => ({ orgSlug: ORG_SLUG }),
}));

import { WebFeatureFlagProvider } from "@/__tests__/helpers/web-feature-flag-provider";
import { OnboardingChecklist } from "../onboarding-checklist";

const ORG_SLUG = "acme";
const INVITE_LABEL = "Invite team members";
const DOWNLOAD_LABEL = "Download the desktop app";
const MEMBERS_HREF = "/settings?tab=organization#/organization-members";
const DMG_HREF = "https://example.com/Closedloop-universal.dmg";

function item(
  id: ChecklistItemId,
  overrides: Partial<OnboardingChecklistItem> = {}
): OnboardingChecklistItem {
  return {
    id,
    label: id,
    description: `${id} description`,
    completed: false,
    ...overrides,
  };
}

function anchorFor(label: string): HTMLAnchorElement {
  const row = screen.getByText(label).closest("a");
  if (!row) {
    throw new Error(`No anchor around the ${label} row`);
  }
  return row as HTMLAnchorElement;
}

/**
 * ISS-7089: the API hands the checklist ORG-RELATIVE hrefs. Rendering one
 * straight into the anchor made the click land on the proxy's missing-org-prefix
 * redirect, and a redirect cannot carry a URL fragment — the browser never sends
 * one — so the members deep link arrived as a bare Organization tab.
 */
describe("onboarding checklist — row destinations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.status = {
      wizardCompleted: true,
      checklistDismissed: false,
      checklist: [
        item(ChecklistItemId.InviteMembers, {
          label: INVITE_LABEL,
          href: MEMBERS_HREF,
        }),
        item(ChecklistItemId.DownloadDesktop, {
          label: DOWNLOAD_LABEL,
          href: DMG_HREF,
          external: true,
        }),
      ],
    };
  });

  it("org-prefixes an in-app row and keeps its query and fragment", () => {
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(anchorFor(INVITE_LABEL).getAttribute("href")).toBe(
      `/${ORG_SLUG}${MEMBERS_HREF}`
    );
  });

  it("leaves an off-app row's absolute URL untouched", () => {
    render(<OnboardingChecklist />, { wrapper: WebFeatureFlagProvider });

    expect(anchorFor(DOWNLOAD_LABEL).getAttribute("href")).toBe(DMG_HREF);
  });
});
