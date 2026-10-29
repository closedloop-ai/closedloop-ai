import { ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchesTable } from "../branches-table";

/**
 * ISS-6384 — the Branches Linked Sessions cell moving onto the shared
 * `CountCell`.
 *
 * The ticket named `renderBranchSessions` as the cell that ALREADY modelled the
 * right behaviour (a 0-count is the empty value, never a dead link), so the
 * value of these cases is the opposite of the usual migration suite: they pin
 * that the flag does NOT cost the surface anything it had. The one case that
 * asserts a difference is the runtime-only one the type does not police.
 */

const ROW: BranchRow = {
  id: "owner%2Fweb::feature",
  branchName: "feature/full",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: 42,
  prTitle: "Add feature",
  prUrl: "https://gh/owner/web/pull/42",
  prState: "OPEN",
  checksPassed: 12,
  checksTotal: 12,
  checksStatus: "PASSING",
  behind: 1,
  ahead: 2,
  additions: 10,
  deletions: 5,
  sessionCount: 3,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

const SESSIONS_HREF = "/branches/owner%2Fweb::feature/sessions";
/** Any linked-sessions link, singular or plural. */
const LINKED_SESSION_LINK_PATTERN = /linked session/;

/**
 * One render per case, deliberately. Mounting `BranchesTable` twice in a single
 * `it` (an on arm and an off arm) pushed the case past the runner's default
 * timeout on this fixture — the two arms are the same assertion under two flag
 * positions, so they split cleanly rather than needing a longer clock.
 */
function renderTable({
  sharedCells,
  row = ROW,
  linked = true,
}: {
  sharedCells: boolean;
  row?: BranchRow;
  linked?: boolean;
}) {
  return render(
    <AppCoreStoryProviders
      enabledFlags={
        sharedCells ? [ARTIFACT_CELL_PRIMITIVES_FEATURE_FLAG_KEY] : []
      }
    >
      <BranchesTable
        getSessionsHref={linked ? () => SESSIONS_HREF : undefined}
        items={[row]}
        mode="expanded"
      />
    </AppCoreStoryProviders>
  );
}

describe("Branches Linked Sessions cell (ISS-6384)", () => {
  it("keeps the linked-sessions count a named link under the shared cell", () => {
    renderTable({ sharedCells: true });

    // Singular/plural is the property the ticket said a shared primitive had to
    // carry to absorb this call site: "3 linked sessions", never "3 linked
    // session" and never a bare "3" a screen reader cannot place.
    expect(
      screen.getByRole("link", { name: "3 linked sessions" })
    ).toHaveAttribute("href", SESSIONS_HREF);
  });

  it("names a single linked session in the singular", () => {
    renderTable({ sharedCells: true, row: { ...ROW, sessionCount: 1 } });

    expect(
      screen.getByRole("link", { name: "1 linked session" })
    ).toBeInTheDocument();
  });

  it("offers no link for a zero count under the shared cell", () => {
    renderTable({ sharedCells: true, row: { ...ROW, sessionCount: 0 } });

    // A link into an empty list is a dead end.
    expect(
      screen.queryByRole("link", { name: LINKED_SESSION_LINK_PATTERN })
    ).toBeNull();
    expect(screen.getByText("No linked sessions")).toBeInTheDocument();
  });

  it("offered no link for a zero count before the shared cell either", () => {
    // The flag-OFF arm of the case above. It is the reason the ticket called
    // this cell the reference: the rule did not have to be invented here.
    renderTable({ sharedCells: false, row: { ...ROW, sessionCount: 0 } });

    expect(
      screen.queryByRole("link", { name: LINKED_SESSION_LINK_PATTERN })
    ).toBeNull();
  });

  it("reports a count that cannot be real as unavailable, not as none", () => {
    // `sessionCount` is declared `number`, but it is built from an API
    // response — so a negative can arrive at runtime.
    renderTable({ sharedCells: true, row: { ...ROW, sessionCount: -1 } });

    expect(screen.getByText("linked sessions unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No linked sessions")).toBeNull();
  });

  it("called that same impossible count 'none' before the shared cell", () => {
    // The flag-OFF arm: `<= 0` swallows a negative into the empty state, so the
    // row claims a count it does not have. This is the one behavioural gain of
    // the migration, and it is worth nothing unless the old branch provably
    // lacked it.
    renderTable({ sharedCells: false, row: { ...ROW, sessionCount: -1 } });

    expect(screen.queryByText("linked sessions unavailable")).toBeNull();
  });

  it("renders a plain count with no link when the host supplies no route", () => {
    renderTable({ sharedCells: true, linked: false });

    expect(
      screen.queryByRole("link", { name: LINKED_SESSION_LINK_PATTERN })
    ).toBeNull();
    expect(screen.getByText("3 linked sessions")).toBeInTheDocument();
  });
});
