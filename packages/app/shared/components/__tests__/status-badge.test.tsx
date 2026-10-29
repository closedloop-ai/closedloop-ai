import { Priority } from "@closedloop-ai/loops-api/common";
import { DocumentStatus, IssueStatus } from "@closedloop-ai/loops-api/document";
import {
  DocumentStatusBadge,
  IssuePriorityBadge,
  IssueStatusBadge,
  StatusBadge,
} from "@repo/app/shared/components/status-badge";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
});

/** A member only a newer peer knows, arriving as a wire string. */
const SKEWED_MEMBER = "BLOCKER";

describe("StatusBadge", () => {
  const colorMap = {
    open: "bg-success/10 text-success",
    closed: "bg-muted text-muted-foreground",
  };

  it("renders the raw status text using the matching color entry", () => {
    render(<StatusBadge colorMap={colorMap} status="open" />);
    const badge = screen.getByText("open");
    expect(badge.className).toContain("bg-success/10");
  });

  it("falls back to the caller's defaultStyle for an unknown status", () => {
    render(
      <StatusBadge
        colorMap={colorMap}
        defaultStyle="bg-warning/10"
        status="pending-review"
      />
    );
    const badge = screen.getByText("pending-review");
    expect(badge.className).toContain("bg-warning/10");
    expect(badge.className).not.toContain("bg-success/10");
  });

  it("falls back to the color map's first entry when no defaultStyle is given", () => {
    render(<StatusBadge colorMap={colorMap} status="unknown-status" />);
    const badge = screen.getByText("unknown-status");
    expect(badge.className).toContain("bg-success/10");
  });

  it("merges a caller-supplied className", () => {
    render(
      <StatusBadge className="extra-class" colorMap={colorMap} status="open" />
    );
    expect(screen.getByText("open").className).toContain("extra-class");
  });
});

describe("DocumentStatusBadge", () => {
  const cases: [DocumentStatus, string, string][] = [
    [DocumentStatus.Draft, "Draft", "bg-muted"],
    [DocumentStatus.InReview, "In Review", "bg-info/10"],
    [DocumentStatus.ChangesRequested, "Changes Requested", "bg-warning/10"],
    [DocumentStatus.Approved, "Approved", "bg-success/10"],
    [DocumentStatus.Executed, "Executed", "bg-success/10"],
    [DocumentStatus.Obsolete, "Obsolete", "bg-muted"],
  ];

  for (const [status, label, colorUtility] of cases) {
    it(`renders ${status} as "${label}"`, () => {
      render(<DocumentStatusBadge status={status} />);
      const badge = screen.getByText(label);
      expect(badge.className).toContain(colorUtility);
    });
  }
});

describe("IssueStatusBadge", () => {
  const cases: [IssueStatus, string, string][] = [
    [IssueStatus.Triage, "Triage", "bg-ai/10"],
    [IssueStatus.Backlog, "Backlog", "bg-muted"],
    [IssueStatus.Todo, "Todo", "bg-warning/10"],
    [IssueStatus.InProgress, "In Progress", "bg-info/10"],
    [IssueStatus.InReview, "In Review", "bg-info/10"],
    [IssueStatus.Blocked, "Blocked", "bg-destructive/10"],
    [IssueStatus.Done, "Done", "bg-success/10"],
    [IssueStatus.Canceled, "Canceled", "bg-muted"],
  ];

  for (const [status, label, colorUtility] of cases) {
    it(`renders ${status} as "${label}"`, () => {
      render(<IssueStatusBadge status={status} />);
      const badge = screen.getByText(label);
      expect(badge.className).toContain(colorUtility);
    });
  }
});

describe("IssuePriorityBadge", () => {
  const cases: [Priority, string, string][] = [
    [Priority.Low, "Low", "bg-info/10"],
    [Priority.Medium, "Medium", "bg-warning/10"],
    [Priority.High, "High", "bg-destructive/10"],
    [Priority.Urgent, "Urgent", "bg-destructive/10"],
  ];

  for (const [priority, label, colorUtility] of cases) {
    it(`renders ${priority} as "${label}"`, () => {
      render(<IssuePriorityBadge priority={priority} />);
      const badge = screen.getByText(label);
      expect(badge.className).toContain(colorUtility);
    });
  }

  it("names a member this build does not know, rather than an empty pill", () => {
    // `priority` is a wire value from /search, so a member only a newer peer
    // knows reaches this badge at runtime. Both fallbacks in the flag-OFF arm
    // exist for it: without them the label map and the tone map both index to
    // `undefined` and the badge renders an empty, untoned box, which a reader
    // takes as "no priority". And this is the SHIPPED arm, because the gate
    // below is closed by default.
    const { container } = render(
      <IssuePriorityBadge priority={SKEWED_MEMBER as Priority} />
    );
    expect(screen.getByText(SKEWED_MEMBER)).toBeTruthy();
    expect(container.querySelector('[data-slot="badge"]')?.className).toContain(
      "bg-info/10"
    );
  });
});

describe("IssuePriorityBadge behind artifact-priority-surfaces (ISS-9307)", () => {
  /** Mounts the badge with one named flag open, so the KEY is what is pinned. */
  function renderWithFlag(enabledKey: string, priority: Priority) {
    return render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [enabledKey] })}
      >
        <IssuePriorityBadge priority={priority} />
      </FeatureFlagAdapterProvider>
    );
  }

  it("renders the champion mark when the gate is open", () => {
    const { container } = renderWithFlag(
      ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
      Priority.High
    );
    expect(
      container.querySelector('[data-slot="artifact-priority"]')
    ).not.toBeNull();
  });

  it("tells High and Urgent apart, which the forked tone map could not", () => {
    // The reason this collapse is worth shipping: the pre-ISS-9307 map gave both
    // COLOR_FAILURE, so the two loudest values were one colour.
    const high = renderWithFlag(
      ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
      Priority.High
    );
    const highTone =
      high.container.querySelector('[data-slot="priority-badge"]')?.className ??
      "";
    cleanup();
    const urgent = renderWithFlag(
      ARTIFACT_PRIORITY_SURFACES_FEATURE_FLAG_KEY,
      Priority.Urgent
    );
    const urgentTone =
      urgent.container.querySelector('[data-slot="priority-badge"]')
        ?.className ?? "";
    expect(highTone).not.toBe("");
    expect(urgentTone).not.toBe("");
    expect(highTone).not.toBe(urgentTone);
  });

  it("keeps the old badge when a DIFFERENT flag is the one that is open", () => {
    // What pins the key rather than the branch: retyping the argument to any
    // other string leaves the champion unreachable in production, and with no
    // provider mounted every other case in this file passes either way.
    const { container } = renderWithFlag("some-other-flag", Priority.High);
    expect(
      container.querySelector('[data-slot="artifact-priority"]')
    ).toBeNull();
    expect(screen.getByText("High").className).toContain("bg-destructive/10");
  });
});
