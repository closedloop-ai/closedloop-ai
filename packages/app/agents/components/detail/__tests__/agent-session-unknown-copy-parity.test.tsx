import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_STATUS_LABELS } from "@repo/api/src/types/session-status-display";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { agentSessionToSessionTableRow } from "../../../lib/session-table-row";
import { SessionStatusBadge } from "../../session-status-badges";
import { createAgentSessionListItemFixture } from "../../sessions/session-list-fixtures";
import {
  populatedAgentSessionDetailFixture,
  UNRECOGNIZED_AGENT_SESSION_STATUS,
  unknownStateAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/*
 * ISS-4654 (PR #4630 review): the Sessions LIST and the session DETAIL must say
 * the SAME thing about a status neither of them can interpret.
 *
 * ISS-10364 (operator ruling, 2026-09-23) changed what "the same thing" is for
 * an unparsable status: `resolveDisplayedSessionStatus` no longer folds it to
 * `unknown` — it fails open to `active`, the same fail-open every other
 * unrecognized spelling takes. This test still pins parity, just against the
 * new answer. Each surface is driven through its OWN production entry point on
 * the same raw wire value — the list through `agentSessionToSessionTableRow`,
 * the detail through a rendered `AgentSessionDetailView` — so a change that
 * touches only one side's derivation reddens here instead of shipping a silent
 * split. The ISS-4997 sentinel-swap mock this file used to run (substituting
 * the Unknown label so two hardcoded copies of it couldn't drift) went with
 * the disclosure it was defending — neither surface renders that disclosure
 * for this input any more, so there is no hardcoded copy left to catch
 * drifting.
 */

const WHITESPACE_RUN = /\s+/g;

function normalize(text: string | null | undefined): string {
  return (text ?? "").replace(WHITESPACE_RUN, " ").trim();
}

async function renderDetailStatusRowName(
  session: AgentSessionDetail
): Promise<string> {
  render(
    <AppCoreStoryProviders>
      <AgentSessionDetailView
        backHref="/sessions"
        isLoading={false}
        session={session}
      />
    </AppCoreStoryProviders>
  );
  // The Properties panel is collapsed by default; the Status ROW lives in the
  // expanded body, so open it the way a user does rather than reaching past it.
  await userEvent.click(screen.getByText("Properties"));
  const statusRow = screen.getByText("Status").closest(".prd-prop");
  // `.prd-prop-value` is the one wrapper both value treatments share — a plain
  // `<span>` for an unexplained status, a `<button>` (with the `sr-only`
  // disclosure tail) for an explained one — so this reads the rendered name
  // whichever branch a given status takes, rather than assuming a button that
  // only the explained treatment renders.
  return normalize(statusRow?.querySelector(".prd-prop-value")?.textContent);
}

describe("unknown session-status copy parity, list vs detail (ISS-4654)", () => {
  it("gives the detail Status row the same plain name the list pill folds an unparsable status to", async () => {
    const detailName = await renderDetailStatusRowName(
      unknownStateAgentSessionDetailFixture
    );

    // tamsinb review (#7820): the list side is built by the LIST MAPPER, not
    // by calling the shared fold directly. The pill reads
    // `agentSessionToSessionTableRow`, which routes through
    // `resolveDisplayedSessionStatusWithWaiting` — so a fold invoked here in
    // isolation stayed green under exactly the mapper-side drift this case
    // claims to catch.
    const listDisplayedStatus = agentSessionToSessionTableRow(
      createAgentSessionListItemFixture({
        status: UNRECOGNIZED_AGENT_SESSION_STATUS,
      }),
      "owner/repo"
    ).status;
    expect(listDisplayedStatus).toBe(SESSION_STATUS.ACTIVE);
    const { container } = render(
      <SessionStatusBadge status={listDisplayedStatus} />
    );
    const listName = normalize(container.textContent);

    expect(listName).toContain(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]);
    expect(detailName).toContain(SESSION_STATUS_LABELS[SESSION_STATUS.ACTIVE]);
    // The pin itself: one word, one fold, both screens.
    expect(detailName).toBe(listName);
  });

  it("leaves a recognized state's Status row plain, with no borrowed disclosure", async () => {
    // Guards the disclosure from leaking onto every row: the fixture's status
    // is a state this build knows, so its Status row must stay the bare word
    // it has always been.
    const detailName = await renderDetailStatusRowName(
      populatedAgentSessionDetailFixture
    );

    expect(detailName).toContain(
      SESSION_STATUS_LABELS[SESSION_STATUS.INACTIVE]
    );
  });
});
