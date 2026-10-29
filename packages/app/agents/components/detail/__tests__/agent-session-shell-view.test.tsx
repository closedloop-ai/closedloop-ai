import type { TraceTextAnchor } from "@repo/api/src/types/comment";
import { CommentSurface } from "@repo/api/src/types/comment";
import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import type { ArtifactCommentAddress } from "@repo/app/documents/components/artifact-activity/artifact-activity-rows";
import { ArtifactDetailTab } from "@repo/app/shared/lib/artifact-detail-tab";
import { isRecord } from "@repo/lib/harness/type-guards";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  createAgentSessionDetailFixture,
  populatedAgentSessionDetailFixture,
} from "../agent-session-detail-fixtures";
import type { AgentSessionDetailViewProps } from "../agent-session-detail-view";
import { AgentSessionShellView } from "../agent-session-shell-view";
import type { SessionCommentsPaneProps } from "../session-comments-pane";
import type { SessionShellDetailsProps } from "../session-shell-details";

const {
  readDetailProps,
  readPaneProps,
  readActivityProps,
  readShellDetailsProps,
  onReady,
  replace,
  query,
  selectTabThenReveal,
} = vi.hoisted(() => ({
  readDetailProps: vi.fn(),
  readPaneProps: vi.fn(),
  readActivityProps: vi.fn(),
  readShellDetailsProps: vi.fn(),
  onReady: vi.fn(),
  replace: vi.fn(),
  query: { value: "" },
  selectTabThenReveal: vi.fn(),
}));

vi.mock("../session-comments-pane", () => ({
  SessionCommentsPane: (props: SessionCommentsPaneProps) => {
    readPaneProps(props);
    return null;
  },
}));

vi.mock("../agent-session-detail-view", () => ({
  AgentSessionDetailView: (props: AgentSessionDetailViewProps) => {
    readDetailProps(props);
    return (
      <input
        aria-label="Retained Artifact draft"
        defaultValue={props.session?.id ?? "Absent session"}
      />
    );
  },
}));

vi.mock("../session-shell-details", () => ({
  SessionShellDetails: (props: SessionShellDetailsProps) => {
    readShellDetailsProps(props);
    return <span>Production Details</span>;
  },
  SessionShellCollaborators: () => <span>Production collaborators</span>,
}));

vi.mock("../session-shell-activity", () => ({
  SessionShellActivity: (props: {
    buildCommentHref: (threadId: string) => string;
    sessionId: string;
  }) => {
    readActivityProps(props);
    return <span>Production activity for {props.sessionId}</span>;
  },
}));

vi.mock(
  "@repo/app/shared/components/artifact-detail-shell/use-artifact-detail-tab-route",
  () => ({
    useArtifactDetailTabRoute: () => {
      const [activeTab, setActiveTab] = useState<ArtifactDetailTab>(
        ArtifactDetailTab.Sessions
      );
      return {
        activeTab,
        setActiveTab,
        onActivePanelReady: onReady,
        selectTabThenReveal,
      };
    },
  })
);

vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(query.value),
}));
vi.mock("@repo/navigation/use-navigation", () => ({
  useNavigation: () => ({ replace }),
}));
vi.mock("@repo/navigation/use-path", () => ({
  usePath: () => "/sessions/test",
}));

describe("AgentSessionShellView", () => {
  it("maps the existing view into Session and retains its state across tabs", async () => {
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Session",
      "Details",
      "Activity",
    ]);
    const artifactDraft = screen.getByRole("textbox", {
      name: "Retained Artifact draft",
    });
    fireEvent.change(artifactDraft, { target: { value: "Draft in progress" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByText("Production Details")).toBeInTheDocument();
    expect(artifactDraft).toBeInTheDocument();
    expect(artifactDraft).not.toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      screen.getByText(
        `Production activity for ${populatedAgentSessionDetailFixture.id}`
      )
    ).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Session" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(screen.getByRole("textbox")).toBe(artifactDraft);
    expect(artifactDraft).toHaveValue("Draft in progress");
    await waitFor(() =>
      expect(onReady).toHaveBeenLastCalledWith(ArtifactDetailTab.Sessions)
    );
  });

  it("puts the Session, Details and Activity tabs on the framed canvas card, the Session workspace filling its card (ISS-12412)", () => {
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );
    const card = (tab: string, label: string) => {
      const region = within(
        screen.getByRole("tabpanel", { name: tab })
      ).getByRole("region", { name: label });
      expect(region).toHaveAttribute("data-artifact-frame", "framed");
      return region;
    };
    const session = card("Session", "Session");
    expect(
      within(session).getByRole("textbox", { name: "Retained Artifact draft" })
    ).toBeInTheDocument();
    // The workspace keeps its own scroller, so the card sizes it unpadded.
    expect(session.firstElementChild).toHaveClass("flex-1", "min-h-0");
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      within(card("Details", "Session details")).getByText("Production Details")
    ).toBeVisible();
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(
      within(card("Activity", "Session activity")).getByText(
        `Production activity for ${populatedAgentSessionDetailFixture.id}`
      )
    ).toBeVisible();
  });

  /**
   * ISS-11004: the comments themselves arrive in the feed the panel reads, so
   * what only this host can supply is the LINK — it owns the route and knows
   * which of its tabs holds the comments rail. The panel's own suite mounts it
   * bare, so nothing else fails if this host stops supplying it.
   */
  it("hands the Activity panel a link to the comment's rail tab", () => {
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );

    // The shell unmounts an inactive tab, so the panel mounts only once its
    // tab is selected.
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });

    // ISS-10980 widened the builder's input from a bare thread id to the
    // comment's ADDRESS, so a host can route on the thread's surface. Session
    // has one rail and ignores the surface, which is what this pins: every
    // address lands on the Sessions tab.
    expect(commentHrefBuilder()({ surface: null, threadId: "c-1" })).toBe(
      `/sessions/test?tab=${ArtifactDetailTab.Sessions}&comment=c-1`
    );
    expect(
      commentHrefBuilder()({
        surface: CommentSurface.BranchTimeline,
        threadId: "c-1",
      })
    ).toBe(`/sessions/test?tab=${ArtifactDetailTab.Sessions}&comment=c-1`);
  });

  /**
   * whitlockk, PR #8562: the Sessions panel stays mounted and `?comment=` survives
   * tab changes, so the panel only sees the address while its tab is active.
   * Clearing it on the way out is what lets the same link reveal again. The
   * comments pane that replaced the legacy rail (PLN-2162 M6) gets the same.
   */
  it("forwards the addressed thread only while the rail's tab is active", () => {
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        selectedThreadId="thread-1"
        session={populatedAgentSessionDetailFixture}
      />
    );
    expect(readDetailProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedThreadId: "thread-1" })
    );
    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ addressedThreadId: "thread-1" })
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(readDetailProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedThreadId: null })
    );
    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ addressedThreadId: null })
    );

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Session" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(readDetailProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ selectedThreadId: "thread-1" })
    );
    expect(readPaneProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ addressedThreadId: "thread-1" })
    );
  });

  it("forwards existing routing, transcript, availability and comment inputs", () => {
    const buildTranscriptFileHref = (file: string) =>
      `/sessions/test?file=${file}`;
    const detailProps = {
      backHref: "/sessions",
      commentsRailOpen: false,
      isLoading: false,
      session: populatedAgentSessionDetailFixture,
      transcriptFileKey: "subagent:child",
      transcriptNeverExpected: true,
      buildTranscriptFileHref,
      artifactHrefPending: true,
    };
    render(<AgentSessionShellView {...detailProps} />);
    // Exact, not `objectContaining`: this is what holds ISS-12269's gate in
    // place. The shell turns the Properties card off because its Details tab
    // states those values, and the legacy page — which has no Details tab —
    // must keep receiving the default.
    expect(readDetailProps).toHaveBeenLastCalledWith({
      ...detailProps,
      rendersPropertiesCard: false,
      tabParamName: "view",
      // PLN-2162 M6: the shell's comments pane hosts the comments now.
      traceCommentsHost: expect.objectContaining({ highlightAnchor: null }),
    });
  });

  /*
   * ISS-12269 moved the Sync row onto the Details tab, so that tab now needs the
   * ISS-7516 never-expected answer the Sessions panel already had. Graded on the
   * value the tab RECEIVES, because the three outcomes are distinguishable only
   * there: `undefined` is the prop deleted, `true` is the shell's own answer
   * handed straight through, and `false` is `resolveTranscriptNeverExpected`
   * actually applied. A case that only passed the prop without a served level
   * would read the same under the first two (tamsinb review, PR #8612).
   */
  it("resolves the Details tab's never-expected answer rather than forwarding the shell's (ISS-12269)", () => {
    const fullLevelSession = createAgentSessionDetailFixture({
      dataSyncLevel: DataSyncLevel.Full,
    });
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={fullLevelSession}
        transcriptNeverExpected
      />
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(readShellDetailsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ transcriptNeverExpected: false })
    );
  });

  it("keeps the shell's own never-expected answer when no level was served (ISS-12269)", () => {
    // The version-skew arm of the same fold: an older server reports no level,
    // so the desktop shell's answer is all there is and must survive the move.
    expect(populatedAgentSessionDetailFixture.dataSyncLevel).toBeUndefined();
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
        transcriptNeverExpected
      />
    );
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });

    expect(readShellDetailsProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ transcriptNeverExpected: true })
    );
  });

  it("mounts the comments pane in place of the legacy rail, on the Session tab", () => {
    render(
      <AgentSessionShellView
        backHref="/sessions"
        commentsRailOpen={false}
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );
    const pane = (): SessionCommentsPaneProps =>
      readPaneProps.mock.lastCall?.[0];
    const host = () => readDetailProps.mock.lastCall?.[0].traceCommentsHost;
    expect(pane()).toEqual(
      expect.objectContaining({
        selectTabThenReveal,
        sessionId: populatedAgentSessionDetailFixture.id,
        traceSelection: null,
        visible: true,
      })
    );
    // One jump, published by the trace and read by the pane.
    expect(pane().traceJump).toBe(host().jumpToRowRef);

    const selection: TraceTextAnchor = {
      endOffset: 2,
      row: 5,
      selectedText: "ok",
      sourceText: "ok",
      startOffset: 0,
      traceId: "trace",
      turnId: "turn-5",
    };
    act(() => host().onTraceSelectionChange(selection));
    expect(pane().traceSelection).toBe(selection);
    expect(host().highlightAnchor).toBe(selection);

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Details" }), {
      button: 0,
      ctrlKey: false,
    });
    expect(pane().visible).toBe(false);
  });

  it("spends the trace selection on a reveal or a posted thread, so the highlight follows the reveal", () => {
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );
    const pane = (): SessionCommentsPaneProps =>
      readPaneProps.mock.lastCall?.[0];
    const host = () => readDetailProps.mock.lastCall?.[0].traceCommentsHost;
    const passage = (row: number): TraceTextAnchor => ({
      endOffset: 2,
      row,
      selectedText: "ok",
      sourceText: "ok",
      startOffset: 0,
      traceId: "trace",
      turnId: `turn-${row}`,
    });
    const selected = passage(5);
    const revealed = passage(9);

    act(() => host().onTraceSelectionChange(selected));
    act(() => pane().onRevealedAnchorChange(revealed));
    expect(host().highlightAnchor).toBe(revealed);
    expect(pane().traceSelection).toBeNull();

    act(() => host().onTraceSelectionChange(selected));
    expect(host().highlightAnchor).toBe(selected);
    act(() => pane().onTraceSelectionUsed());
    expect(pane().traceSelection).toBeNull();
    expect(host().highlightAnchor).toBe(revealed);
  });

  it("leaves loading and missing states to the existing view outside the shell", () => {
    render(<AgentSessionShellView backHref="/sessions" isLoading />);
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Absent session");
    expect(readDetailProps).toHaveBeenLastCalledWith({
      backHref: "/sessions",
      isLoading: true,
    });
  });

  it("does not redirect an ordinary Details link with the default main file", () => {
    query.value = "tab=details";
    replace.mockClear();
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
        transcriptFileKey="main"
      />
    );
    expect(replace).not.toHaveBeenCalled();
    query.value = "";
  });

  /**
   * OPERATOR RULING, 2026-10-06. This case used to assert the opposite — a cold
   * load carrying a file dropped the tab and landed on the session canvas.
   * `useTabParam` keeps `?file=` across tabs, so a reloaded or shared
   * `?file=subagent:x&tab=details` lost the tab the sender explicitly chose
   * (tamsinb review, PR #8461). The ruling: a cold load honors the tab and
   * drops the stale selection instead. The post-mount case below is kept as the
   * counterfactual — addressing a file AFTER mount still goes to the canvas,
   * which ISS-12167 moved onto the Sessions tab.
   */
  it("honors an explicit tab on a cold load and drops the stale file", () => {
    query.value = "tab=details&view=trace&file=subagent%3Achild";
    replace.mockClear();
    render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
        transcriptFileKey="subagent:child"
      />
    );
    expect(replace).toHaveBeenCalledWith(
      "/sessions/test?tab=details&view=trace",
      {
        scroll: false,
      }
    );
    query.value = "";
  });

  it("still clears the tab when a file is addressed after mount", () => {
    query.value = "tab=details&view=trace";
    replace.mockClear();
    const view = render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );
    expect(replace).not.toHaveBeenCalled();

    // The user opens a subagent file from the Details tab.
    query.value = "tab=details&view=trace&file=subagent%3Achild";
    view.rerender(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
        transcriptFileKey="subagent:child"
      />
    );

    expect(replace).toHaveBeenCalledWith(
      "/sessions/test?file=subagent%3Achild",
      { scroll: false }
    );
    query.value = "";
  });

  it("resets the retained Artifact when the session identity changes", () => {
    const view = render(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={populatedAgentSessionDetailFixture}
      />
    );
    const draft = screen.getByRole("textbox");
    fireEvent.change(draft, { target: { value: "Previous session draft" } });
    view.rerender(
      <AgentSessionShellView
        backHref="/sessions"
        isLoading={false}
        session={{ ...populatedAgentSessionDetailFixture, id: "next-session" }}
      />
    );
    expect(screen.getByRole("textbox")).not.toBe(draft);
    expect(screen.getByRole("textbox")).toHaveValue("next-session");
  });
});

/**
 * The link builder the host handed the Activity panel. Narrowed rather than
 * cast, so a panel that never rendered fails as that, not as a call on
 * `undefined`.
 */
function commentHrefBuilder(): (address: ArtifactCommentAddress) => string {
  const props = readActivityProps.mock.calls.at(0)?.at(0);
  if (!isRecord(props) || typeof props.buildCommentHref !== "function") {
    throw new Error("The Activity panel never received a link builder");
  }
  return props.buildCommentHref as (address: ArtifactCommentAddress) => string;
}
