import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import type { RelatedSessionsResult } from "@repo/api/src/types/related-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactListCell } from "@repo/app/artifacts/components/artifact-list-cells";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { restoreTimeZone } from "@repo/app/shared/test-fixtures/tz-utils";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { relatedSessionNoun } from "../related-sessions-cell";

/** One initial on every avatar (Nerys, 2026-10-22), and nothing else. */
const ONLY_A = /^A$/;

const NOW = new Date("2026-10-08T18:00:00.000Z");
const ORIGINAL_TIME_ZONE = process.env.TZ;
const SESSION = {
  sessionArtifactId: "session-artifact-1",
  slug: "SES-101",
  name: "Document revision",
  status: SESSION_STATUS.ACTIVE,
  owner: {
    id: "owner-1",
    firstName: "Avery",
    lastName: "Example",
    avatarUrl: null,
  },
  kind: ProvenanceRelationshipKind.Contribution,
  contributedAt: "2026-10-08T17:31:00.000Z",
};

function mount(data?: RelatedSessionsResult, isLoading = false) {
  const navigation = createMemoryNavigation({ orgSlug: "example" });
  const result = render(
    <NavigationProvider adapter={navigation.adapter}>
      <TooltipProvider>
        <ArtifactListCell
          columnId="relatedSessions"
          document={createMockDocument()}
          editHandlers={{}}
          relatedLoading={isLoading}
          relatedSessions={data}
        />
      </TooltipProvider>
    </NavigationProvider>
  );
  return { ...result, navigation };
}

describe("Documents related-session grid chips", () => {
  beforeEach(() => {
    process.env.TZ = "America/Chicago";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(90);
  });

  afterEach(() => {
    restoreTimeZone(ORIGINAL_TIME_ZONE);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders compact calendar labels, owner initials, status tone and session navigation", () => {
    const { navigation } = mount({
      items: [
        SESSION,
        {
          ...SESSION,
          sessionArtifactId: "session-artifact-2",
          slug: "SES-102",
          status: SESSION_STATUS.INACTIVE,
          contributedAt: "2026-10-07T12:00:00.000Z",
        },
      ],
      total: 2,
    });
    const active = screen.getByRole("link", {
      name: ACTIVE_SESSION_NAME,
    });
    expect(active.textContent).toMatch(TIME_OF_DAY);
    expect(active).toHaveClass("text-success");
    expect(active).toHaveAttribute(
      "href",
      "/example/sessions/session-artifact-1"
    );
    const earlier = screen.getByRole("link", {
      name: INACTIVE_SESSION_NAME,
    });
    expect(earlier).toHaveTextContent("10/07");
    expect(earlier).toHaveClass("text-muted-foreground");
    // One initial on every avatar (Nerys, 2026-10-22).
    expect(
      active.querySelector('[data-slot="avatar-fallback"]')
    ).toHaveTextContent(ONLY_A);
    fireEvent.click(active);
    expect(navigation.getCurrentHref()).toBe(
      "/example/sessions/session-artifact-1"
    );
  });

  // EXPECTATION CHANGED, not weakened. This case pinned the chip reading
  // "Unknown" for a version-skewed status, which was correct when #8610 landed.
  // ISS-10364 (operator ruling, Cosimo Corrigan, 2026-09-23/24) retired the
  // Unknown display word, so an unrecognized spelling fails open to Active like
  // every other fold in this vocabulary. The deleted-owner half of the case is
  // untouched by the ruling and is kept, and the counterfactual is kept too:
  // Active must come with Active's own styling, not the muted styling the
  // retired word carried.
  it("folds version-skewed statuses to Active and retains a deleted owner's session", () => {
    mount({
      items: [{ ...SESSION, owner: null, status: "future-status" }],
      total: 1,
    });
    const link = screen.getByRole("link", {
      name: SKEWED_STATUS_SESSION_NAME,
    });
    expect(link).toHaveClass("text-success");
    expect(link).not.toHaveClass("text-muted-foreground");
  });

  it("renders the server-withheld remainder through the shared overflow disclosure", () => {
    mount({ items: [SESSION], total: 4 });
    expect(screen.getByText("+3")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: ACTIVE_SESSION_NAME })
    ).toBeInTheDocument();
  });

  it("retains a positive total as a named count when no session rows were delivered", () => {
    mount({ items: [], total: 2 });
    expect(screen.getByText(`2 ${relatedSessionNoun(2)}`)).toBeInTheDocument();
    expect(screen.queryByText("+2")).not.toBeInTheDocument();
    expect(screen.queryByTitle("No related sessions")).not.toBeInTheDocument();
  });

  it("keeps sessions dropped for width reachable from the overflow tooltip", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(130);
    const { navigation } = mount({
      items: [
        SESSION,
        {
          ...SESSION,
          sessionArtifactId: "session-artifact-2",
          slug: "SES-102",
          status: SESSION_STATUS.INACTIVE,
          contributedAt: "2026-10-07T12:00:00.000Z",
        },
        {
          ...SESSION,
          sessionArtifactId: "session-artifact-3",
          slug: "SES-103",
          contributedAt: "2026-10-06T12:00:00.000Z",
        },
      ],
      total: 3,
    });
    expect(
      screen.getByRole("link", { name: ACTIVE_SESSION_NAME })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: INACTIVE_SESSION_NAME })
    ).not.toBeInTheDocument();

    fireEvent.focus(screen.getByText("+2"));
    const tooltip = screen.getByRole("tooltip");
    const hidden = within(tooltip).getByRole("link", {
      name: INACTIVE_SESSION_NAME,
    });
    expect(hidden).toHaveAttribute(
      "href",
      "/example/sessions/session-artifact-2"
    );
    expect(
      within(tooltip).getByRole("link", { name: HIDDEN_THIRD_SESSION_NAME })
    ).toHaveAttribute("href", "/example/sessions/session-artifact-3");
    fireEvent.click(hidden);
    expect(navigation.getCurrentHref()).toBe(
      "/example/sessions/session-artifact-2"
    );
  });

  it("distinguishes loading, unavailable and computed empty", () => {
    const loading = mount(undefined, true);
    expect(
      screen.getByLabelText("Loading related sessions…")
    ).toBeInTheDocument();
    loading.unmount();
    const unavailable = mount();
    expect(screen.getByTitle("Unavailable")).toBeInTheDocument();
    unavailable.unmount();
    mount({ items: [], total: 0 });
    expect(screen.getByTitle("No related sessions")).toBeInTheDocument();
  });
});

const ACTIVE_SESSION_NAME = /SES-101 · Avery Example · Active · Contributed/;
const INACTIVE_SESSION_NAME = /SES-102 · Avery Example · Inactive/;
const HIDDEN_THIRD_SESSION_NAME = /SES-103 · Avery Example · Active/;
const SKEWED_STATUS_SESSION_NAME =
  /SES-101 · Unknown owner · Active · Contributed/;
const TIME_OF_DAY = /\d{1,2}:\d{2}\s?(AM|PM)/;
