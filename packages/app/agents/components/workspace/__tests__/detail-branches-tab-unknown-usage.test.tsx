/**
 * ISS-5529: the component-detail Branches tab must not deny branches the payload
 * never measured.
 *
 * ISS-5363 split "measured none" from "could not measure" on the Sessions tab
 * and the token-trend chart. This tab kept a two-arm read — an attributed branch
 * name, or a flat denial — because its signal rides a nested `branchName` rather
 * than the top-level count that pass was hunting. `branchesTab` and
 * `usageSessions[].branchName` are both projections of one branch-attribution
 * read, and desktop's local reader has no such projection at all, so their joint
 * silence is the producer's and not the org's.
 *
 * These pin the three states apart at the RENDER boundary, each driven from a
 * payload that genuinely produces it, and pin the gate closed by default.
 */

import type { AgentComponentDetail } from "@repo/api/src/types/agent-component";
import { AGENTS_BRANCH_USAGE_SIGNAL_STATES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DetailBranchesTab } from "../detail-branches-tab";

type UsageSessions = AgentComponentDetail["usageSessions"];

/** Session usage WITH branch attribution — direct evidence branches exist. */
const ATTRIBUTED_USAGE: UsageSessions = [
  { sessionId: "s-1", branchName: "feat/story-branch", invocationCount: 2 },
];

/**
 * Session usage from a producer that projects NO branch attribution — the rows
 * carry no `branchName` field at all, which is desktop's local reader shape
 * (`{ sessionId, invocationCount }`). The ISS-5529 case: the component
 * demonstrably ran, and nothing in the payload says whether a branch referenced
 * it.
 */
const UNATTRIBUTED_USAGE: UsageSessions = [
  { sessionId: "s-1", invocationCount: 3 },
  { sessionId: "s-2", invocationCount: 1 },
];

/**
 * Session usage from a producer that DID run the branch attribution and found
 * none — the cloud read always pushes the field, so an explicit `null` is the
 * measurement "this session ran on no branch", not a gap. Distinct from
 * {@link UNATTRIBUTED_USAGE} by the presence of the key alone.
 */
const MEASURED_NO_BRANCH_USAGE: UsageSessions = [
  { sessionId: "s-1", branchName: null, invocationCount: 3 },
  { sessionId: "s-2", branchName: null, invocationCount: 1 },
];

/**
 * #7013 (whitlockk): ONE row the producer measured to no branch, and one it never
 * projected at all. A `some`-style test reads this set as measured and counts
 * the unprojected row as a zero; only `every` sees that session s-2's branch is
 * still unknown. Reachable from a version-skewed producer mid-upgrade, and the
 * exact shape a completeness predicate exists to catch.
 */
const MIXED_ATTRIBUTION_USAGE: UsageSessions = [
  { sessionId: "s-1", branchName: null, invocationCount: 3 },
  { sessionId: "s-2", invocationCount: 1 },
];

/** A MEASURED empty usage set — no session ran it, so no branch can cite it. */
const NO_USAGE: UsageSessions = [];

function renderTab(
  usageSessions: UsageSessions | undefined,
  {
    honest = true,
    branchesTabTruncated = false,
  }: { honest?: boolean; branchesTabTruncated?: boolean } = {}
) {
  return render(
    <DetailBranchesTab
      branches={[]}
      branchesTabTruncated={branchesTabTruncated}
      usageSessions={usageSessions}
    />,
    {
      wrapper: ({ children }) => (
        <AppCoreStoryProviders
          enabledFlags={
            honest ? [AGENTS_BRANCH_USAGE_SIGNAL_STATES_FEATURE_FLAG_KEY] : []
          }
        >
          {children}
        </AppCoreStoryProviders>
      ),
    }
  );
}

describe("DetailBranchesTab — unmeasured branch attribution (ISS-5529)", () => {
  it("does not deny branches when sessions ran but no branch attribution arrived", () => {
    renderTab(UNATTRIBUTED_USAGE);

    expect(screen.getByText("Branches unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This data source couldn't report the branches for this component."
      )
    ).toBeInTheDocument();
    // The reported defect: a confident denial the payload cannot support.
    expect(screen.queryByText("No branches yet")).toBeNull();
    // Nor may it claim branches exist — it does not know that either.
    expect(screen.queryByText("Branch details unavailable")).toBeNull();
  });

  it("does not deny branches when a skewed payload omits the usage rows", () => {
    renderTab(undefined);

    expect(screen.getByText("Branches unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).toBeNull();
    expect(screen.queryByText("Branch details unavailable")).toBeNull();
  });

  it("still states the true zero plainly when usage WAS measured as none", () => {
    renderTab(NO_USAGE);

    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(
      screen.getByText("No branches reference this component yet.")
    ).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
    expect(screen.queryByText("Branch details unavailable")).toBeNull();
  });

  it("states the true zero when the producer measured branch attribution and found none", () => {
    // The cloud read runs the attribution unconditionally and pushes
    // `branchName: null` for a session it found no branch link for, so this IS a
    // measurement. Reading it as unmeasured would print a producer failure over
    // a component that simply has no branches — the inverse of this ticket's
    // defect, and the reason the fold keys off the FIELD rather than the value.
    renderTab(MEASURED_NO_BRANCH_USAGE);

    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
    expect(screen.queryByText("Branch details unavailable")).toBeNull();
  });

  it("does not deny branches when only SOME usage rows carry the attribution field", () => {
    // whitlockk, #7013: the per-row half of completeness. One row measured to no
    // branch does not make the row beside it — which the producer never
    // projected — a measured zero, so the set proves nothing and the denial is
    // still unavailable. A `some`-style test reads this as measured.
    renderTab(MIXED_ATTRIBUTION_USAGE);

    expect(screen.getByText("Branches unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).toBeNull();
    expect(screen.queryByText("Branch details unavailable")).toBeNull();
  });

  it("does not deny branches when the producer declares the attribution read truncated", () => {
    // davetho, #7013: the producer-declared half. A producer older than
    // ISS-9855 caps its branch-attribution lookup below its own session set
    // while still emitting a usage row per session, so a session past it is
    // `branchName: null` — the SAME bytes as a session the read reached and
    // found no branch for. `branchesTabTruncated` is the only thing that
    // separates them, so a null-only payload under it proves no zero.
    renderTab(MEASURED_NO_BRANCH_USAGE, { branchesTabTruncated: true });

    expect(screen.getByText("Branches unavailable")).toBeInTheDocument();
    expect(screen.queryByText("No branches yet")).toBeNull();
    expect(screen.queryByText("Branch details unavailable")).toBeNull();
  });

  it("still reports positive attribution as Present even when the read was truncated", () => {
    // davetho asked for this explicitly: truncation makes a ZERO unprovable,
    // never a POSITIVE. A row naming a branch is direct evidence branches
    // reference this component, and a bounded read cannot retract it — so the
    // completeness doubt must not swallow the one thing the payload does prove.
    renderTab(ATTRIBUTED_USAGE, { branchesTabTruncated: true });

    expect(screen.getByText("Branch details unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
    expect(screen.queryByText("No branches yet")).toBeNull();
  });

  it("keeps the shipped denial for a truncated read when the gate is closed", () => {
    // The closed default is today's behavior verbatim, truncation included:
    // `legacyBranchSignal` reads only the attributed count, so this still
    // denies. Pins that the fix is entirely inside the gate.
    renderTab(MEASURED_NO_BRANCH_USAGE, {
      branchesTabTruncated: true,
      honest: false,
    });

    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
  });

  it("keeps the details-unavailable copy when branch attribution exists but rows do not", () => {
    renderTab(ATTRIBUTED_USAGE);

    expect(screen.getByText("Branch details unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This data source can't list the branches that reference this component."
      )
    ).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
    expect(screen.queryByText("No branches yet")).toBeNull();
  });

  it("keeps the shipped two-arm reading when the gate is closed (default OFF)", () => {
    renderTab(UNATTRIBUTED_USAGE, { honest: false });

    // Flag OFF is today's behavior verbatim, including its denial.
    expect(screen.getByText("No branches yet")).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
  });

  it("keeps the attributed arm reachable when the gate is closed", () => {
    renderTab(ATTRIBUTED_USAGE, { honest: false });

    expect(screen.getByText("Branch details unavailable")).toBeInTheDocument();
    expect(screen.queryByText("Branches unavailable")).toBeNull();
  });
});
