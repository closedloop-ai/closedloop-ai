import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { act, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { FeatureFlagAdapterProvider } from "../../../shared/feature-flags/provider";
import { DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY } from "../../../shared/lib/feature-flags";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { EDITOR_READY_TIMEOUT_MS } from "../../hooks/use-editor-session";
import { DOCUMENT_EDITOR_DETAILS_TEST_ID } from "../document-editor-details";
import { DocumentEditorScaffold } from "../document-editor-scaffold";
import { EDITOR_LOAD_TIMEOUT_TITLE } from "../editor-body-load-failure";
import {
  EDITOR_LOADING_LABEL,
  editorBodyClassName,
  editorLoaderClassName,
} from "../editor-body-status-region";
import { FeedArtifactType } from "../feed-sidebar/types";

/**
 * The editor body's loading and failure region (ISS-7058, ISS-8514).
 *
 * Same leaf stubs as the sibling chat-slot suite so the real scaffold mounts in
 * jsdom without Liveblocks or Tiptap. The gating logic under test runs unmocked.
 */
vi.mock("@repo/collaboration/client/optional-document-room", () => ({
  OptionalDocumentRoom: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@repo/collaboration/client/presence", () => ({
  InlinePresence: () => null,
}));
vi.mock("@repo/collaboration/client/scroll-to-anchor", () => ({
  scrollToAnchor: vi.fn(),
}));
vi.mock("@repo/rich-text/rich-text-toolbar", () => ({
  RichTextToolbar: () => null,
}));
// Held so a test can fire the readiness signal the real editor sends after
// Y.Doc sync — the only thing that ever clears the never-ready failure.
const editorBodyProbe = vi.hoisted(() => ({
  onContentReady: undefined as (() => void) | undefined,
}));
vi.mock("../collaborative-editor-body", () => ({
  CollaborativeEditorBody: (props: { onContentReady?: () => void }) => {
    editorBodyProbe.onContentReady = props.onContentReady;
    return null;
  },
}));
// Its project list resolves off a query, so with timers driven forward it
// renders against an unsettled fixture. Irrelevant to the editor-body rules.
vi.mock("../move-entity-dialog", () => ({
  MoveEntityDialog: () => null,
}));
vi.mock("../editor/document-feed-rail", () => ({
  DocumentFeedRail: () => null,
}));
vi.mock("../editor/document-room-event-listener", () => ({
  DocumentRoomEventListener: () => null,
}));
vi.mock("../editor/editable-document-title", () => ({
  EditableDocumentTitle: () => null,
}));
vi.mock("../../../users/hooks/use-users", () => ({
  useCurrentUser: () => ({ data: null, isLoading: false }),
}));

// Derived, never a second copy of the literal: a hand-duplicated Tailwind
// string drifts on the next padding tweak and fails as if it were a regression.
const EDITOR_LOADER_LOADING_CLASS = editorLoaderClassName(false);
const EDITOR_LOADER_RESERVED_CLASS = editorLoaderClassName(false, false, true);

function readLoaderClassName(): string {
  return screen.getByRole("status", {
    hidden: true,
    name: EDITOR_LOADING_LABEL,
  }).className;
}

function createDocumentDetail(content: string): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Loading region doc",
    slug: "PRD-1",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion: 2,
    latestVersionContent: content,
    createdById: "user-1",
    createdBy: null,
    assigneeId: null,
    assignee: null,
    approverId: null,
    approver: null,
    repositorySnapshot: {
      createdAt: now.toISOString(),
      repositories: [],
      source: "none",
    },
    templateForType: null,
    sortOrder: null,
    createdAt: now,
    updatedAt: now,
    version: {
      id: "version-2",
      documentId: "document-1",
      version: 2,
      content,
      createdById: "user-1",
      createdAt: now,
    },
  };
}

function renderScaffold(options: {
  content: string;
  currentVersion?: number;
  enabledFlags?: readonly string[];
  /** Mounted INSIDE the harness, so it can override the flag adapter. */
  wrapper?: (props: { children: ReactNode }) => ReactNode;
}) {
  const Wrapper = options.wrapper ?? PassThrough;
  return render(
    <AppCoreStoryProviders enabledFlags={options.enabledFlags ?? []}>
      <Wrapper>
        <DocumentEditorScaffold
          currentVersion={options.currentVersion ?? 2}
          deleteDialogTitle="PRD"
          detailsSections={() => null}
          document={createDocumentDetail(options.content)}
          feedArtifactType={FeedArtifactType.Prd}
          onVersionChange={vi.fn()}
          redirectPath="/org-test/prds"
          renderHeader={() => null}
        />
      </Wrapper>
    </AppCoreStoryProviders>
  );
}

function PassThrough({ children }: { children: ReactNode }) {
  return children;
}

/**
 * ISS-7058, the silent path into an invisible body: the editor that never
 * becomes ready. In jsdom nothing ever calls `handleEditorReady`, which
 * is exactly the production shape of a Liveblocks room that never syncs, so
 * mounting and letting the clock run reproduces it directly.
 */
describe("DocumentEditorScaffold editor that never becomes ready", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("waits behind a spinner rather than an error while still loading", async () => {
    renderScaffold({ content: "# A real PRD" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDITOR_READY_TIMEOUT_MS - 1000);
    });
    expect(screen.queryByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeNull();
    expect(readLoaderClassName()).toBe(EDITOR_LOADER_LOADING_CLASS);
  });

  test("states the failure instead of waiting forever behind a hidden body", async () => {
    renderScaffold({ content: "# A real PRD" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDITOR_READY_TIMEOUT_MS);
    });
    expect(screen.getByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeTruthy();
    expect(readLoaderClassName()).toBe("hidden");
  });

  // ISS-8514 AC 2: reserving space must not become a reserved BLANK. The gated
  // region fills the content area, which is exactly the shape that could swallow
  // the failure -- a viewport-tall spinner over the top of "the editor didn't
  // load" is the trade this ticket is forbidden to make. The suppression is
  // ordered ahead of the height, and this is what proves the order.
  test("states the failure rather than reserving a blank viewport", async () => {
    renderScaffold({
      content: "# A real PRD",
      enabledFlags: [DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY],
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDITOR_READY_TIMEOUT_MS);
    });
    expect(screen.getByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeTruthy();
    expect(readLoaderClassName()).toBe("hidden");
  });

  // A timeout that cannot be taken back is its own lie: a slow room that lands
  // after the deadline has to clear the state, not strand the user on it.
  test("clears the failure if the editor turns up late", async () => {
    renderScaffold({ content: "# A real PRD" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(EDITOR_READY_TIMEOUT_MS);
    });
    expect(screen.getByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeTruthy();

    await act(async () => {
      editorBodyProbe.onContentReady?.();
      await Promise.resolve();
    });
    expect(screen.queryByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeNull();
  });
});

/**
 * The visibility rule itself, which the mounted suite above cannot distinguish:
 * in jsdom the editor never reaches `isEditorReady`, so it carries the hidden
 * class either way. These assert the decision directly.
 */
describe("editor visibility while the editor comes up", () => {
  test("shows the editor normally once it is ready", () => {
    expect(editorBodyClassName(true)).toBeUndefined();
  });

  test("keeps the editor hidden while it is still coming up", () => {
    expect(editorBodyClassName(false)).toBe("invisible h-0 overflow-hidden");
  });

  test("still shows the spinner while loading", () => {
    expect(editorLoaderClassName(false)).toBe(
      "flex flex-1 items-center justify-center py-24"
    );
  });

  // A spinner next to "the editor didn't load" claims the wait is still on.
  test("suppresses the spinner once the editor is declared failed", () => {
    expect(editorLoaderClassName(false, true)).toBe("hidden");
  });

  // ISS-8514. The two spellings are pinned against independently written
  // literals rather than against each other, because the whole fix is that they
  // DIFFER: `flex-1` is inert under the scaffold's block canvas wrapper and
  // collapses the region to its padding, `min-h-full` resolves against that
  // wrapper and reserves one viewport. A single derived constant would let
  // both sides drift to the same string and stay green.
  test("reserves the content area's height once the gate is on", () => {
    expect(editorLoaderClassName(false, false, true)).toBe(
      "flex min-h-full items-center justify-center py-24"
    );
  });

  test("still suppresses the spinner on failure with the gate on", () => {
    expect(editorLoaderClassName(false, true, true)).toBe("hidden");
  });
});

/**
 * ISS-8514. Production RUM attributes 91.8% of document views above 0.1 CLS to
 * `DIV[data-testid="document-editor-details"]`: while the editor comes up its
 * body is `invisible h-0`, so the detail stack sits just under a ~216px spinner
 * band and then falls the full body height once the editor mounts. The gated
 * region reserves the content area instead, which puts the stack at the fold so
 * the same displacement happens off-screen.
 *
 * jsdom has no layout engine, so the CLASS is the assertable contract here and
 * the geometry is not; what these pin is that the gate reaches the DOM at all,
 * in both positions, and that reserving the space does not remove the thing the
 * space is being reserved for.
 */
describe("DocumentEditorScaffold loading region reservation", () => {
  test("reserves the content area while the editor is coming up", async () => {
    renderScaffold({
      content: "# A real PRD",
      enabledFlags: [DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY],
    });
    await waitFor(() => {
      expect(readLoaderClassName()).toBe(EDITOR_LOADER_RESERVED_CLASS);
    });
    expect(screen.queryByTestId(DOCUMENT_EDITOR_DETAILS_TEST_ID)).toBeNull();
    expect(screen.getByRole("tab", { name: "Details" })).toBeInTheDocument();
  });

  test("leaves the collapsing region alone while the gate is off", async () => {
    renderScaffold({ content: "# A real PRD" });
    await waitFor(() => {
      expect(readLoaderClassName()).toBe(EDITOR_LOADER_LOADING_CLASS);
    });
    expect(screen.queryByTestId(DOCUMENT_EDITOR_DETAILS_TEST_ID)).toBeNull();
    expect(screen.getByRole("tab", { name: "Details" })).toBeInTheDocument();
  });

  // The gate's own shift, and the reason a SETTLED answer is latched rather than
  // read live. This adapter implements no `useFeatureFlagResolved`, so the port
  // reads it as resolved from the first render — a genuine "off for this user",
  // not an unanswered one. Acting on the later flip would grow the region from
  // ~216px to a full viewport mid-wait and push the detail stack down by the
  // difference — the same element, moving, for the same reason the ticket
  // exists. The latch makes the gate monotonic per load.
  test("ignores a gate that flips after it has already settled", async () => {
    const flag: { turnOn: () => void } = { turnOn: () => undefined };
    function LateFlagProvider({ children }: { children: ReactNode }) {
      const [enabled, setEnabled] = useState(false);
      flag.turnOn = () => setEnabled(true);
      return (
        <FeatureFlagAdapterProvider
          adapter={{
            useFeatureFlagEnabled: (key) =>
              enabled &&
              key === DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY,
          }}
        >
          {children}
        </FeatureFlagAdapterProvider>
      );
    }
    renderScaffold({
      content: "# A real PRD",
      wrapper: LateFlagProvider,
    });
    await waitFor(() => {
      expect(readLoaderClassName()).toBe(EDITOR_LOADER_LOADING_CLASS);
    });

    await act(async () => {
      flag.turnOn();
      await Promise.resolve();
    });
    expect(readLoaderClassName()).toBe(EDITOR_LOADER_LOADING_CLASS);
  });

  // The counterpart, and the one production actually mounts (PR #6345, whitlockk).
  // The web adapter resolves through PostHog, so the FIRST render answers
  // "unresolved", which `useFeatureFlagEnabled` reports as `false` — the
  // anonymous bootstrap's default, not this user's assignment. Latching THAT
  // would close the gate on every real load and the flag could never open.
  // The gate is latched to the first SETTLED answer instead, so a targeted user
  // gets the treatment on the load they were targeted for.
  test("reserves once the gate settles on, not on the unresolved first paint", async () => {
    const flag: { settleOn: () => void } = { settleOn: () => undefined };
    function UnresolvedThenOnProvider({ children }: { children: ReactNode }) {
      const [settled, setSettled] = useState(false);
      flag.settleOn = () => setSettled(true);
      return (
        <FeatureFlagAdapterProvider
          adapter={{
            useFeatureFlagEnabled: (key) =>
              settled &&
              key === DOCUMENT_EDITOR_STABLE_LOADING_REGION_FEATURE_FLAG_KEY,
            useFeatureFlagResolved: () => settled,
          }}
        >
          {children}
        </FeatureFlagAdapterProvider>
      );
    }
    renderScaffold({
      content: "# A real PRD",
      wrapper: UnresolvedThenOnProvider,
    });
    await waitFor(() => {
      expect(readLoaderClassName()).toBe(EDITOR_LOADER_LOADING_CLASS);
    });

    await act(async () => {
      flag.settleOn();
      await Promise.resolve();
    });
    expect(readLoaderClassName()).toBe(EDITOR_LOADER_RESERVED_CLASS);
  });
});
