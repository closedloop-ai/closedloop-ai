import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/app/agents/hooks/use-agent-sessions", () => ({
  useAgentSessions: vi.fn(),
}));

vi.mock("@repo/navigation/link", () => ({
  Link: ({
    href,
    children,
    ...rest
  }: {
    href: string;
    children: ReactNode;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { useAgentSessions } from "@repo/app/agents/hooks/use-agent-sessions";
import { PROJECT_ACTIVE_SESSIONS_DATE_RANGE } from "@repo/app/agents/lib/project-active-sessions";
import { SESSION_DATE_RANGE_PARAM } from "@repo/app/agents/lib/session-date-range-param";
import { ProjectActiveSessionsStatus } from "@/app/(authenticated)/[orgSlug]/teams/[teamId]/projects/[projectId]/components/project-active-sessions-status";

const ORG_SLUG = "closedloop-ai";
const PROJECT_ID = "019f8008-1969-74f9-b056-99c13cca9a07";
const ZERO_STATE_TEXT = /No active sessions/;
// A literal rendered "0" count — the value the unavailable state must never
// stand in for.
const ZERO_COUNT_TEXT = /^0 active/;
// ISS-5355: the retired vocabulary, matched anywhere in the rendered strip.
const LOOPS_VOCABULARY = /loops?/i;
const UNAVAILABLE_TEXT = "Active sessions unavailable";

type SessionsQueryResult = ReturnType<typeof useAgentSessions>;

function mockQuery(result: {
  total?: number;
  isLoading?: boolean;
  isLoadingError?: boolean;
}) {
  vi.mocked(useAgentSessions).mockReturnValue({
    data: result.total === undefined ? undefined : { total: result.total },
    isLoading: result.isLoading ?? false,
    isLoadingError: result.isLoadingError ?? false,
  } as unknown as SessionsQueryResult);
}

function renderStrip() {
  return render(
    <ProjectActiveSessionsStatus orgSlug={ORG_SLUG} projectId={PROJECT_ID} />
  );
}

describe("ProjectActiveSessionsStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The strip is an ADDITIVE notice: it earns a full-width band only when it has
  // something to report. What the predecessor got wrong was hiding a FAILED read
  // behind the same blank as a quiet project — that separation is what these
  // assertions pin, not "renders in every state".
  it("occupies no band while the count is still loading", () => {
    // A skeleton bar that appears and then vanishes on nearly every project load
    // is a layout shift bought for no information (bot review).
    mockQuery({ isLoading: true });

    const { container } = renderStrip();

    expect(container.firstChild).toBeNull();
  });

  it("reports a failed read as unavailable, never as zero", () => {
    mockQuery({ isLoadingError: true });

    renderStrip();

    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
    // The two ways an unavailable read could lie: claim there is nothing
    // running, or paint a literal 0.
    expect(screen.queryByText(ZERO_STATE_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByText(ZERO_COUNT_TEXT)).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    // Not still-loading either — a failed read is a settled answer.
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-busy", "true");
  });

  it("occupies no band at a genuine zero", () => {
    // Rendering here put a permanent grey "No active sessions" bar on top of
    // every project page — a third stacked horizontal band before the artifacts
    // table, on the overwhelmingly common case (bot review). The strip's silence
    // is "no notice", never a claim about a value.
    mockQuery({ total: 0 });

    const { container } = renderStrip();

    expect(container.firstChild).toBeNull();
    expect(screen.queryByText(ZERO_STATE_TEXT)).not.toBeInTheDocument();
  });

  it("still renders a failed read even though zero and loading render nothing", () => {
    // The load-bearing separation: a broken read must not look like a quiet
    // project. That conflation is the regression the predecessor shipped.
    mockQuery({ isLoadingError: true });

    const { container } = renderStrip();

    expect(container.firstChild).not.toBeNull();
    expect(screen.getByText(UNAVAILABLE_TEXT)).toBeInTheDocument();
  });

  it("renders the real count as a link to the filtered Sessions listing", () => {
    mockQuery({ total: 10 });

    renderStrip();

    const link = screen.getByRole("link", {
      name: "View 10 active sessions in this project",
    });
    expect(link).toHaveTextContent("10 active sessions");

    // The destination must arrive with the filter APPLIED, expressed in the URL
    // so it is linkable and back-button correct — not merely "a link exists".
    const url = new URL(
      link.getAttribute("href") ?? "",
      "https://app.closedloop.ai"
    );
    expect(url.pathname).toBe(`/${ORG_SLUG}/sessions`);
    expect(url.searchParams.getAll("project")).toEqual([PROJECT_ID]);
    expect(url.searchParams.getAll("status")).toEqual([SESSION_STATUS.ACTIVE]);
    // ISS-5355 (bot review): the window the count used travels with the link, so
    // the destination cannot silently re-window the rows the number described.
    expect(url.searchParams.get(SESSION_DATE_RANGE_PARAM)).toBe(
      PROJECT_ACTIVE_SESSIONS_DATE_RANGE
    );
  });

  it("signals the count is clickable without requiring a hover", () => {
    // The count is the only interactive thing in the strip. Inheriting the
    // strip's `text-muted-foreground` and revealing an underline only on hover
    // left no resting affordance — invisible to a keyboard or touch reader (bot
    // review).
    mockQuery({ total: 4 });

    renderStrip();

    const link = screen.getByRole("link", {
      name: "View 4 active sessions in this project",
    });
    expect(link.className).toContain("underline");
    expect(link.className).toContain("text-primary");
    expect(link.className).not.toContain("hover:underline");
  });

  it("singularizes a count of one", () => {
    mockQuery({ total: 1 });

    renderStrip();

    expect(
      screen.getByRole("link", {
        name: "View 1 active session in this project",
      })
    ).toHaveTextContent("1 active session");
  });

  it("queries the count with the shared project+active predicate", () => {
    mockQuery({ total: 3 });

    renderStrip();

    expect(useAgentSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        projectIds: [PROJECT_ID],
        statuses: [SESSION_STATUS.ACTIVE],
      }),
      expect.anything()
    );
  });

  // ISS-5355: "Loops" is no longer an officially exposed concept. Assert the
  // vocabulary's ABSENCE so it cannot creep back into this slot.
  it.each([
    ["unavailable", { isLoadingError: true }],
    ["populated", { total: 10 }],
  ])("uses no Loops vocabulary in the %s state", (_name, result) => {
    mockQuery(result);

    const { container } = renderStrip();

    expect(container.textContent ?? "").not.toMatch(LOOPS_VOCABULARY);
  });
});
