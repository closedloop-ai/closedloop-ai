// @vitest-environment jsdom

import { ChecklistItemId } from "@repo/api/src/types/onboarding";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enabledFlags: new Set<string>(),
  flagReady: true,
  status: null as unknown,
  currentUser: { id: "user-1" } as { id: string } | undefined,
  orgId: "org_acme" as string | undefined,
  resizeObserved: [] as Element[],
}));

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({
    organization: mocks.orgId === undefined ? null : { id: mocks.orgId },
  }),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagGate: (key: string) => ({
    enabled: mocks.enabledFlags.has(key),
    isReady: mocks.flagReady,
  }),
}));
vi.mock("@repo/app/onboarding/hooks/use-onboarding", () => ({
  useOnboardingStatus: () => ({ data: mocks.status }),
}));
vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: mocks.currentUser }),
}));
vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: ({ open }: { open?: boolean }) =>
    open ? <div data-testid="invite-dialog" /> : null,
}));

import { InviteSpotlightHost } from "../invite-spotlight-host";

const SPOTLIGHT_FLAG = "invite-spotlight";
const SPOTLIGHT_LABEL = "Invite your team";
const MAYBE_LATER = /maybe later/i;
const INVITE_BUTTON = /^invite$/i;
const SUPPRESSION_KEY = "closedloop.invite-spotlight-dismissed.org_acme.user-1";
const ANCHOR_SELECTOR = `[data-checklist-item="${ChecklistItemId.InviteMembers}"]`;
const VIEWPORT_HEIGHT = 768;
const ANCHOR_TOP = 700;

/**
 * The spotlight measures a real element, so the anchor the checklist stamps has
 * to exist in the document for it to render at all.
 *
 * Nested the way the checklist actually renders it — list > `Link` > row — not
 * appended straight to `<body>`. The row's parent is an anchor element, and an
 * anchor's box does not change when a sibling row is inserted above it, so a
 * flat fixture would make "observe the parent" and "observe the list" look
 * identical to every assertion here.
 */
function mountAnchor() {
  const list = document.createElement("div");
  list.setAttribute("data-checklist-items", "");
  const link = document.createElement("a");
  const anchor = document.createElement("div");
  anchor.setAttribute("data-checklist-item", ChecklistItemId.InviteMembers);
  link.append(anchor);
  list.append(link);
  document.body.append(list);
  return anchor;
}

function setStatus(
  overrides: {
    wizardCompleted?: boolean;
    checklistDismissed?: boolean;
    inviteCompleted?: boolean;
  } = {}
) {
  mocks.status = {
    wizardCompleted: overrides.wizardCompleted ?? true,
    checklistDismissed: overrides.checklistDismissed ?? false,
    checklist: [
      {
        id: ChecklistItemId.InviteMembers,
        label: "Invite team members",
        description: "Add colleagues to your organization",
        completed: overrides.inviteCompleted ?? false,
      },
    ],
  };
}

describe("InviteSpotlightHost", () => {
  beforeEach(() => {
    mocks.enabledFlags.clear();
    mocks.enabledFlags.add(SPOTLIGHT_FLAG);
    mocks.flagReady = true;
    mocks.currentUser = { id: "user-1" };
    mocks.orgId = "org_acme";
    mocks.resizeObserved = [];
    setStatus();
    localStorage.clear();
    mountAnchor();
    // jsdom's default is 768, but the placement assertions depend on it, so pin
    // it rather than inherit whatever the environment happens to use.
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: VIEWPORT_HEIGHT,
    });
  });

  afterEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  it("nudges toward the invite row when there is something to nudge toward", () => {
    render(<InviteSpotlightHost />);

    expect(screen.getByLabelText(SPOTLIGHT_LABEL)).toBeTruthy();
  });

  it("stays closed while the flag is off", () => {
    mocks.enabledFlags.clear();

    render(<InviteSpotlightHost />);

    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("does not fire once the user has already invited someone", () => {
    setStatus({ inviteCompleted: true });

    render(<InviteSpotlightHost />);

    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("does not fire when the checklist that carries its anchor is dismissed", () => {
    setStatus({ checklistDismissed: true });

    render(<InviteSpotlightHost />);

    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("renders nothing when the anchor is absent instead of pinning a loose card", () => {
    document.body.replaceChildren();

    render(<InviteSpotlightHost />);

    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("suppresses per user on Maybe later, and stays suppressed on remount", () => {
    const { unmount } = render(<InviteSpotlightHost />);

    fireEvent.click(screen.getByRole("button", { name: MAYBE_LATER }));
    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
    expect(localStorage.getItem(SUPPRESSION_KEY)).toBeTruthy();

    unmount();
    document.body.replaceChildren();
    mountAnchor();
    render(<InviteSpotlightHost />);
    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("keeps one user's dismissal off another user's screen", () => {
    localStorage.setItem(SUPPRESSION_KEY, new Date().toISOString());
    mocks.currentUser = { id: "user-2" };

    render(<InviteSpotlightHost />);

    expect(screen.getByLabelText(SPOTLIGHT_LABEL)).toBeTruthy();
  });

  it("still asks in a second org the user has not answered for", () => {
    // Everything deciding whether to nudge is org state — the checklist and the
    // member count both come from the active org — so a dismissal in one org
    // must not silence an org that genuinely has no teammates yet.
    localStorage.setItem(SUPPRESSION_KEY, new Date().toISOString());
    mocks.orgId = "org_other";

    render(<InviteSpotlightHost />);

    expect(screen.getByLabelText(SPOTLIGHT_LABEL)).toBeTruthy();
  });

  it("opens the invite dialog and retires the nudge behind it", () => {
    render(<InviteSpotlightHost />);

    fireEvent.click(screen.getByRole("button", { name: INVITE_BUTTON }));

    expect(screen.getByTestId("invite-dialog")).toBeTruthy();
    // The dialog outlives the button that opened it.
    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("dismisses on Escape", () => {
    render(<InviteSpotlightHost />);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("watches the list for moves no scroll or resize reports", () => {
    // The Google checklist row is inserted above this one when its flag
    // resolves, which shifts the anchor down while the page neither scrolls nor
    // resizes — so the two window listeners never fire and the hole stays cut
    // over the row above.
    class StubResizeObserver {
      observe(target: Element) {
        mocks.resizeObserved.push(target);
      }
      disconnect() {
        // no-op
      }
      unobserve() {
        // no-op
      }
    }
    vi.stubGlobal("ResizeObserver", StubResizeObserver);

    render(<InviteSpotlightHost />);

    const anchor = document.querySelector(ANCHOR_SELECTOR);
    // The LIST is the element whose height an inserted sibling changes. The row
    // keeps its box and so does the `Link` around it, so observing either would
    // report nothing on the move this exists to catch.
    expect(mocks.resizeObserved).toContain(
      document.querySelector("[data-checklist-items]")
    );
    expect(mocks.resizeObserved).not.toContain(anchor?.parentElement);
    // The row itself is still watched, for the case where its own copy rewraps.
    expect(mocks.resizeObserved).toContain(anchor);
  });

  it("leaves the page clickable — the dim never swallows a click", () => {
    const { container } = render(<InviteSpotlightHost />);

    const dim = container.querySelector("[aria-hidden='true']");
    expect(dim?.className).toContain("pointer-events-none");
  });

  it("does not pop in before the flag resolves", () => {
    mocks.flagReady = false;

    render(<InviteSpotlightHost />);

    expect(screen.queryByLabelText(SPOTLIGHT_LABEL)).toBeNull();
  });

  it("dims with a fixed scrim, not one that inverts with the theme", () => {
    const { container } = render(<InviteSpotlightHost />);

    // `var(--foreground)` is near-black in light mode and near-WHITE in dark, so
    // the original dim washed the whole app out on a dark OS.
    const dim = container.querySelector<HTMLElement>("[aria-hidden='true']");
    expect(dim?.style.boxShadow).toContain("rgb(0 0 0 / 0.5)");
  });

  it("flips the card above an anchor that sits near the bottom", () => {
    const anchor = document.querySelector<HTMLElement>(
      `[data-checklist-item="${ChecklistItemId.InviteMembers}"]`
    );
    // jsdom measures everything as 0, so drive the anchor geometry directly: a
    // row low in a 768px viewport, where placing the card below would put it
    // past the fold.
    if (anchor) {
      anchor.getBoundingClientRect = () =>
        ({ top: 700, left: 40, width: 300, height: 40 }) as DOMRect;
    }

    render(<InviteSpotlightHost />);

    const card = screen.getByLabelText(SPOTLIGHT_LABEL) as HTMLElement;
    const top = Number.parseFloat(card.style.top);
    // Below the anchor would be ~760, off the bottom of a 768px viewport. The
    // card is `fixed`, so that is unreachable — the user could only dismiss
    // something they never got to read. Above the anchor (< 708) proves the
    // flip rather than merely proving a number is on screen.
    expect(top).toBeLessThan(ANCHOR_TOP);
    expect(top).toBeGreaterThanOrEqual(0);
  });
});
