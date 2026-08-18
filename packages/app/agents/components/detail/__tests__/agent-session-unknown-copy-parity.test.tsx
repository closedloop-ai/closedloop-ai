import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { DISPLAYED_SESSION_STATUS } from "@repo/api/src/types/session-status";
import { SESSION_UNKNOWN_TOOLTIP } from "@repo/api/src/types/session-status-display";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { SessionStatusBadge } from "../../session-status-badges";
import {
  populatedAgentSessionDetailFixture,
  unknownStateAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";

/*
 * ISS-4654 (PR #4630 review): the Sessions LIST and the session DETAIL must say
 * the SAME thing about a status neither of them can interpret.
 *
 * The terminal labels in `STATUS_DISPLAY_BY_STATE` were deliberately wired to
 * read out of the canonical `SESSION_STATUS_LABELS` so the two surfaces could
 * not drift; the Unknown fallback was not, and it carried no disclosure at all
 * while the list pill has carried one since ISS-4997. The result under version
 * skew was one session reading explained-unknown in the list and unexplained
 * "Unknown" on its own detail page.
 *
 * This test makes that drift a FAILURE rather than a review finding. It
 * REPLACES the canonical unknown label with a sentinel and then renders both
 * surfaces: a hardcoded `label: "Unknown"` on either side keeps rendering the
 * literal word and no longer matches its sibling, and a missing disclosure drops
 * the canonical sentence out of the accessible name. Asserting the two rendered
 * names are EQUAL is the pin — it cannot be satisfied by two independent
 * hardcoded copies of today's identical word.
 */
const { UNKNOWN_LABEL_SENTINEL } = vi.hoisted(() => ({
  UNKNOWN_LABEL_SENTINEL: "Unrecognized-ISS4654-sentinel",
}));

// ISS-5592 split the labels into `session-status-display`, so the label map is
// mocked there while the KEY still comes from the values module. Both are read
// inside the factory rather than from a top-level import: a `vi.mock` factory is
// hoisted above the import block, so a top-level binding is not initialized yet
// when it runs.
vi.mock(
  "@repo/api/src/types/session-status-display",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@repo/api/src/types/session-status-display")
      >();
    const { DISPLAYED_SESSION_STATUS } = await import(
      "@repo/api/src/types/session-status"
    );
    return {
      ...actual,
      SESSION_STATUS_LABELS: {
        ...actual.SESSION_STATUS_LABELS,
        [DISPLAYED_SESSION_STATUS.UNKNOWN]: UNKNOWN_LABEL_SENTINEL,
      },
    };
  }
);

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
  // The whole value — the visible word plus the `sr-only` sentence — IS the
  // accessible name of the explained value, so its text content is the name.
  return normalize(statusRow?.querySelector("button")?.textContent);
}

describe("unknown session-status copy parity, list vs detail (ISS-4654)", () => {
  it("gives the detail Status row the same explained name the list pill has", async () => {
    const detailName = await renderDetailStatusRowName(
      unknownStateAgentSessionDetailFixture
    );

    const { container } = render(
      <SessionStatusBadge status={DISPLAYED_SESSION_STATUS.UNKNOWN} />
    );
    const listName = normalize(
      container.querySelector("[aria-label]")?.getAttribute("aria-label")
    );

    // Both surfaces read the label from the canonical vocabulary — a hardcoded
    // "Unknown" on either side fails here even though the word is identical in
    // production today.
    expect(listName).toContain(UNKNOWN_LABEL_SENTINEL);
    expect(detailName).toContain(UNKNOWN_LABEL_SENTINEL);
    // Both carry the canonical ISS-4997 disclosure, and it is a TAIL: the name
    // leads with the visible word (WCAG 2.5.3 Label in Name).
    expect(listName).toContain(SESSION_UNKNOWN_TOOLTIP);
    expect(detailName).toContain(SESSION_UNKNOWN_TOOLTIP);
    expect(detailName.startsWith(UNKNOWN_LABEL_SENTINEL)).toBe(true);
    // The pin itself: one sentence, one word, one accessible name, both screens.
    expect(detailName).toBe(listName);
  });

  it("leaves a recognized state's Status row plain, with no borrowed disclosure", async () => {
    // Guards the disclosure from leaking onto every row: the fixture is
    // Completed, a state this build knows, so its Status row must stay the bare
    // word it has always been.
    const detailName = await renderDetailStatusRowName(
      populatedAgentSessionDetailFixture
    );

    expect(detailName).not.toContain(SESSION_UNKNOWN_TOOLTIP);
    expect(detailName).not.toContain(UNKNOWN_LABEL_SENTINEL);
  });
});
