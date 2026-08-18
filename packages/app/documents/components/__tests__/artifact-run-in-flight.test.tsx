import type { GenerationStatus } from "@repo/api/src/types/document";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactRunInFlight } from "../artifact-run-in-flight";

const STARTED_AT = new Date("2026-08-11T00:45:21.000Z");
/**
 * Four minutes after {@link STARTED_AT}, pinned so the elapsed clause is an
 * exact string rather than whatever the wall clock makes of a fixed past date.
 * Left to the real clock, `formatRelativeTime` renders "3 hours ago" today and
 * "Aug 11, 2026" next week, so the assertion would drift out from under the
 * test. Only `Date` is faked — faking timers too would take `setTimeout` away
 * from React Testing Library.
 */
const NOW = new Date("2026-08-11T00:49:21.000Z");

const VIEW_SESSION_LINK = /view the session/i;
const QUEUED_TEXT = /queued/i;
const STARTED_TEXT = /started/i;
const EMPTY_ATTRIBUTION = /by null|by undefined|by \s*$/i;
const STARTED_PREFIX = /Started /;

function status(overrides: Partial<GenerationStatus> = {}): GenerationStatus {
  return {
    status: "RUNNING",
    command: "generate_prd",
    htmlUrl: null,
    startedAt: STARTED_AT,
    completedAt: null,
    correlationId: null,
    source: "loop",
    loopId: "loop-1",
    sessionArtifactId: "session-1",
    initiatedBy: { firstName: "Mike", lastName: "Angstadt" },
    ...overrides,
  };
}

function renderTreatment(
  generationStatus: GenerationStatus | undefined,
  variant: "panel" | "banner" = "panel"
) {
  // The treatment renders a `@repo/navigation` Link, which requires a
  // NavigationProvider ancestor. Every mount site needs one -- Storybook gets it
  // from the global app-core decorator (ISS-5665).
  return render(
    <NavigationProvider
      adapter={createMemoryNavigation({ initialPath: "/" }).adapter}
    >
      <ArtifactRunInFlight
        generationStatus={generationStatus}
        orgSlug="closedloop-ai"
        variant={variant}
      />
    </NavigationProvider>
  );
}

describe("ArtifactRunInFlight", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the command using the canonical label, not the raw enum", () => {
    renderTreatment(status());
    expect(screen.getByText("Generate PRD")).toBeTruthy();
    expect(screen.queryByText("generate_prd")).toBeNull();
    expect(screen.queryByText("GENERATE_PRD")).toBeNull();
  });

  it("links to the session for the run", () => {
    renderTreatment(status());
    const link = screen.getByRole("link", { name: VIEW_SESSION_LINK });
    expect(link.getAttribute("href")).toBe("/closedloop-ai/sessions/session-1");
  });

  // The Session artifact is written after the run starts, so an active run
  // legitimately has none for its first moments. A dead link is worse than no
  // link: it says there is somewhere to go and then refuses to go there.
  it("renders no link at all when the session has not materialized", () => {
    const { container } = renderTreatment(
      status({ sessionArtifactId: undefined })
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Generate PRD")).toBeTruthy();
    // Not just "no anchor": no EmptyContent wrapper either. A `link ? … : null`
    // ternary over a JSX element is always truthy, so it kept the wrapper around
    // nothing and left its parent's `gap-6` column hanging under the
    // description — a defect `queryByRole("link")` alone is blind to.
    expect(container.querySelector('[data-slot="empty-content"]')).toBeNull();
  });

  // PENDING folds both LoopStatus.Pending and LoopStatus.Blocked, so an active
  // run may never have started. Claiming it is running asserts execution the
  // system cannot back.
  it("does not claim a queued run has started", () => {
    renderTreatment(status({ status: "PENDING", startedAt: null }));
    const detail = screen.getByRole("status").textContent ?? "";
    expect(QUEUED_TEXT.test(detail)).toBe(true);
    expect(STARTED_TEXT.test(detail)).toBe(false);
  });

  // With the clock pinned this can assert the exact sentence rather than a
  // pattern loose enough to survive whatever the wall clock produced.
  it("reports elapsed time only once the run has actually started", () => {
    renderTreatment(status());
    const detail = screen.getByRole("status").textContent ?? "";
    expect(detail).toContain("Started 4 min ago by Mike Angstadt");
  });

  // The treatment is a polite live region so it is announced on appearance, but
  // a polite region re-announces on every content change and the elapsed clause
  // ticks over once a minute for the length of the run. Only that clause opts
  // out, so the announcement survives and the repeat does not.
  it("suppresses live-region updates for the ticking elapsed clause only", () => {
    renderTreatment(status());
    const region = screen.getByRole("status");
    const silenced = region.querySelectorAll('[aria-live="off"]');
    expect(silenced.length).toBe(1);
    expect(silenced[0]?.textContent).not.toContain("Mike Angstadt");
    expect(region.textContent).toContain("Mike Angstadt");
  });

  it("drops the attribution clause rather than naming a missing initiator", () => {
    renderTreatment(status({ initiatedBy: null }));
    const detail = screen.getByRole("status").textContent ?? "";
    expect(EMPTY_ATTRIBUTION.test(detail)).toBe(false);
    expect(STARTED_PREFIX.test(detail)).toBe(true);
  });

  it("announces itself when it appears", () => {
    renderTreatment(status());
    expect(screen.getByRole("status")).toBeTruthy();
  });

  // The lowercase run-loop vocabulary and the uppercase LoopCommand set are not
  // case transforms of each other, so every member of the closed union has to
  // resolve to a real label rather than the generic fallback.
  it.each([
    ["plan" as const, "Plan"],
    ["execute" as const, "Execute"],
    ["chat" as const, "Chat"],
    ["request_changes" as const, "Request Changes"],
    ["request_prd_changes" as const, "Request PRD Changes"],
    ["generate_prd" as const, "Generate PRD"],
    ["explore" as const, "Explore"],
    ["decompose" as const, "Decompose"],
    ["evaluate_prd" as const, "Evaluate PRD"],
    ["evaluate_plan" as const, "Evaluate Plan"],
    ["evaluate_code" as const, "Evaluate PR"],
    ["evaluate_feature" as const, "Evaluate Issue"],
  ])("labels the %s command %s", (command, label) => {
    renderTreatment(status({ command }));
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("falls back to a generic noun when the command is absent", () => {
    renderTreatment(status({ command: null }));
    expect(screen.getByText("Run")).toBeTruthy();
  });

  it.each([
    ["SUCCESS" as const],
    ["FAILURE" as const],
    ["NONE" as const],
  ])("renders nothing for the terminal status %s", (terminal) => {
    const { container } = renderTreatment(status({ status: terminal }));
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no generation status at all", () => {
    const { container } = renderTreatment(undefined);
    expect(container.firstChild).toBeNull();
  });

  it("shows the same facts in the banner variant", () => {
    renderTreatment(status(), "banner");
    expect(screen.getByText("Generate PRD")).toBeTruthy();
    expect(screen.getByRole("link", { name: VIEW_SESSION_LINK })).toBeTruthy();
  });
});
