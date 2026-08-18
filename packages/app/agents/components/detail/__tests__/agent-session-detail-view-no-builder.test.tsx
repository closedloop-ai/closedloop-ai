import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import { buildSessionDetailContent } from "../detail-content";
import { withProviders } from "./agent-session-detail-view.test-helpers";

// ISS-5072 (#4375 review): the Cost-string parity test passes against the old
// implementation too, because `content.metrics[2]` produced the same dash. The
// actual regression this PR removes is the CALL — building the whole
// O(events · log events) view-model on every render/refetch to read one field.
// Pin it by spying on the builder itself: the spy calls through, so if the view
// (or anything it mounts) ever reaches for `buildSessionDetailContent` again,
// this fails while every behavior assertion elsewhere stays green.
vi.mock("../detail-content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../detail-content")>();
  return {
    ...actual,
    buildSessionDetailContent: vi.fn(actual.buildSessionDetailContent),
  };
});

describe("ISS-5072: session detail never builds the discarded view-model", () => {
  it("does not call buildSessionDetailContent during render or refetch", () => {
    const spy = vi.mocked(buildSessionDetailContent);
    const view = render(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture()}
        />
      )
    );

    // A refetch resolves to a NEW detail object; before ISS-5072 that new
    // reference re-ran the `useMemo` and rebuilt the entire view-model.
    view.rerender(
      withProviders(
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={createAgentSessionDetailFixture()}
        />
      )
    );

    // Positive proof the workspace actually mounted, BEFORE the negative pin —
    // otherwise a view that stopped rendering (or bailed to the not-found
    // branch) would satisfy `not.toHaveBeenCalled()` vacuously and this guard
    // would go green on a broken screen.
    expect(document.querySelector(".sd3-props-preview")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });
});
