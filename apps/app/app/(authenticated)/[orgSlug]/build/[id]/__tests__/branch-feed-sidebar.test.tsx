// @vitest-environment jsdom
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { BranchViewContainer } from "../branch-view-container";
import {
  DEFAULT_ELECTRON_DETECTION_VALUE,
  DEFAULT_ENGINEER_ROUTING_VALUE,
  DEFAULT_USE_QUERY_VALUE,
  makeBranchViewData,
  makeDefaultSyncControlValue,
  renderContainerWithQueryClient,
} from "./_container-test-utils";

const mockUseBranchView = vi.hoisted(() => vi.fn());
const mockUseFeatureFlag = vi.hoisted(() => vi.fn());
const mockUseEngineerRoutingSelection = vi.hoisted(() => vi.fn());
const mockUseElectronDetection = vi.hoisted(() => vi.fn());
const mockUseQuery = vi.hoisted(() => vi.fn());
const mockUseBranchViewSyncControl = vi.hoisted(() => vi.fn());

const mockMutationFactory = vi.hoisted(() => () => ({
  isPending: false,
  mutate: vi.fn(),
  variables: undefined,
  error: null,
}));

vi.mock("@repo/app/documents/hooks/use-branch-view", () => ({
  useBranchView: (...args: unknown[]) => mockUseBranchView(...args),
  useBranchViewSyncControl: (...args: unknown[]) =>
    mockUseBranchViewSyncControl(...args),
  useReplyToComment: mockMutationFactory,
  useCreateBranchViewConversationComment: mockMutationFactory,
  useEditBranchViewConversationComment: mockMutationFactory,
  useDeleteBranchViewConversationComment: mockMutationFactory,
  useEditBranchViewReviewComment: mockMutationFactory,
  useDeleteBranchViewReviewComment: mockMutationFactory,
  useResolveBranchViewReviewThread: mockMutationFactory,
  useUnresolveBranchViewReviewThread: mockMutationFactory,
}));

vi.mock("@repo/analytics/client", () => ({
  useFeatureFlag: (key: string) => mockUseFeatureFlag(key),
}));

vi.mock("@repo/auth/client", () => ({
  useOrganization: () => ({ organization: { id: "org_test", slug: "org" } }),
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-query")>(
    "@tanstack/react-query"
  );
  return {
    ...actual,
    useQuery: (...args: unknown[]) => mockUseQuery(...args),
  };
});

vi.mock("@/lib/engineer/routing-store", () => ({
  useEngineerRoutingSelection: () => mockUseEngineerRoutingSelection(),
}));

vi.mock("@/lib/engineer/electron-detection", () => ({
  useElectronDetection: () => mockUseElectronDetection(),
}));

type StubHeaderProps = {
  onTogglePanel: () => void;
  panelLabel: string;
};
const headerCapture = vi.hoisted(() => ({
  current: null as StubHeaderProps | null,
}));
vi.mock("../components/branch-view-header", () => ({
  BranchViewHeader: (props: StubHeaderProps) => {
    headerCapture.current = props;
    return (
      <button
        data-testid="branch-header-toggle"
        onClick={props.onTogglePanel}
        type="button"
      >
        {props.panelLabel}
      </button>
    );
  },
}));

type StubContentProps = {
  hidePrComments?: boolean;
};
const contentCapture = vi.hoisted(() => ({
  current: null as StubContentProps | null,
}));
vi.mock("../components/branch-view-content", () => ({
  BranchViewContent: (props: StubContentProps) => {
    contentCapture.current = props;
    return <div data-testid="branch-content" />;
  },
}));

vi.mock("../components/branch-diff-view", () => ({
  BranchDiffView: () => <div data-testid="branch-diff" />,
}));

vi.mock("../components/branch-chat-drawer", () => ({
  BranchChatDrawer: () => <div data-testid="branch-chat" />,
}));

type StubFeedSidebarProps = {
  visible: boolean;
  artifactType: string;
  organizationId: string;
  activeTab: string;
  sources: ReadonlyArray<{ id: string }>;
};
const feedSidebarCapture = vi.hoisted(() => ({
  current: null as StubFeedSidebarProps | null,
  renderCount: 0,
}));
vi.mock("@repo/app/documents/components/feed-sidebar/feed-sidebar", () => {
  const FeedTab = { Feed: "feed", Chat: "chat" } as const;
  return {
    FeedTab,
    FeedSidebar: (props: StubFeedSidebarProps) => {
      feedSidebarCapture.current = props;
      feedSidebarCapture.renderCount += 1;
      return props.visible ? (
        <div
          data-active-tab={props.activeTab}
          data-artifact-type={props.artifactType}
          data-source-ids={props.sources.map((s) => s.id).join(",")}
          data-testid="feed-sidebar"
        />
      ) : null;
    },
  };
});

function enableFlags(input: {
  branchPr: boolean;
  feedSidebar: boolean;
  chat: boolean;
}) {
  mockUseFeatureFlag.mockImplementation((key: string) => {
    if (key === "branch-pr") {
      return { enabled: input.branchPr };
    }
    if (key === "interactive-chat") {
      return { enabled: input.chat };
    }
    if (key === "comments-v2-feed-sidebar") {
      return { enabled: input.feedSidebar };
    }
    return { enabled: false };
  });
}

function renderContainer() {
  mockUseBranchView.mockReturnValue({
    data: makeBranchViewData(),
    error: null,
    isLoading: false,
  });
  return renderContainerWithQueryClient(BranchViewContainer);
}

beforeEach(() => {
  feedSidebarCapture.current = null;
  feedSidebarCapture.renderCount = 0;
  headerCapture.current = null;
  contentCapture.current = null;
  vi.clearAllMocks();
  globalThis.localStorage?.clear?.();
  mockUseEngineerRoutingSelection.mockReturnValue(
    DEFAULT_ENGINEER_ROUTING_VALUE
  );
  mockUseElectronDetection.mockReturnValue(DEFAULT_ELECTRON_DETECTION_VALUE);
  mockUseQuery.mockReturnValue(DEFAULT_USE_QUERY_VALUE);
  mockUseBranchViewSyncControl.mockReturnValue(makeDefaultSyncControlValue());
});

describe("BranchViewContainer flag-on FeedSidebar wiring", () => {
  test("hides the inline PR comments section when the flag is on", () => {
    enableFlags({ branchPr: true, feedSidebar: true, chat: false });
    renderContainer();
    expect(contentCapture.current?.hidePrComments).toBe(true);
  });

  test("renders the FeedSidebar with the PR source and Branch artifact", () => {
    enableFlags({ branchPr: true, feedSidebar: true, chat: false });
    renderContainer();
    expect(feedSidebarCapture.current?.artifactType).toBe("BRANCH");
    expect(feedSidebarCapture.current?.organizationId).toBe("org_test");
    expect(feedSidebarCapture.current?.sources.map((s) => s.id)).toEqual([
      "pr-comment",
    ]);
  });

  test("starts with the Feed tab active", () => {
    enableFlags({ branchPr: true, feedSidebar: true, chat: false });
    renderContainer();
    expect(feedSidebarCapture.current?.activeTab).toBe("feed");
  });

  test("header toggle uses the Feed label under the flag", () => {
    enableFlags({ branchPr: true, feedSidebar: true, chat: false });
    renderContainer();
    expect(headerCapture.current?.panelLabel).toBe("Feed");
  });

  test("does not render FeedSidebar when the flag is off", () => {
    enableFlags({ branchPr: true, feedSidebar: false, chat: false });
    renderContainer();
    expect(screen.queryByTestId("feed-sidebar")).toBeNull();
    expect(contentCapture.current?.hidePrComments).toBe(false);
    expect(headerCapture.current?.panelLabel).toBe("Chat");
  });

  test("header toggle closes and reopens the FeedSidebar", () => {
    enableFlags({ branchPr: true, feedSidebar: true, chat: false });
    renderContainer();
    expect(feedSidebarCapture.current?.visible).toBe(true);
    act(() => headerCapture.current?.onTogglePanel());
    expect(feedSidebarCapture.current?.visible).toBe(false);
    act(() => headerCapture.current?.onTogglePanel());
    expect(feedSidebarCapture.current?.visible).toBe(true);
  });
});
