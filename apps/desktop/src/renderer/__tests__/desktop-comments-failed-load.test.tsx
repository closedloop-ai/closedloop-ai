import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { commentApiPaths } from "@repo/api/src/types/comment-thread-dto";
import { BranchCommentsController } from "@repo/app/branches/components/comments/branch-comments-controller";
import { BranchCommentsTab } from "@repo/app/branches/components/comments/branch-comments-model";
import {
  useArtifactComments,
  useHttpCommentsDataSource,
} from "@repo/app/shared/comments/use-artifact-comments";
import { CommentsPaneContent } from "@repo/app/shared/components/comments/comments-pane";
import { READ_ONLY_CAPABILITIES } from "@repo/app/shared/components/comments/comments-pane.fixtures";
import {
  COMMENTS_COUNT_UNAVAILABLE_LABEL,
  NO_ANCHOR_STATE_LABELS,
} from "@repo/app/shared/components/comments/comments-pane-model";
import { useCommentsPaneDrafts } from "@repo/app/shared/components/comments/use-comments-pane-drafts";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudApiFetchResult } from "../../shared/cloud-api-fetch-contract";
import { DesktopAuthStatus } from "../../shared/contracts";
import { DesktopAppCoreProvider } from "../shared-agent-sessions/desktop-app-core-provider";
import type { DesktopAuthState } from "../types/desktop-api";

/**
 * PLN-2162 M5.2 / ISS-11213 AC4: desktop keeps no comment data locally, so a
 * signed-out or offline desktop reads comments from the cloud API like every
 * other mode, the read fails, and both the legacy comments rail and the
 * unified pane show their existing failed-load state. The local IPC store is
 * stubbed with an empty list: reading it would render zero comments instead.
 */

const FLOW_TIMEOUT_MS = 20_000;
/** The failed read is retried twice (1 s, then 2 s) before it settles. */
const SETTLE_TIMEOUT_MS = 8000;

const BRANCH_ID = "branch-iss-11213";
const ARTIFACT_ID = "0199a1b2-0000-7000-8000-00000000a001";

const SIGNED_OUT: DesktopAuthState = {
  status: DesktopAuthStatus.SignedOut,
  userId: null,
  organizationId: null,
};
const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

/** What main answers for a signed-out desktop (`signedOutResponse`). */
const SIGNED_OUT_REPLY: CloudApiFetchResult = {
  kind: "response",
  status: 401,
  statusText: "Unauthorized",
  headers: [["content-type", "application/json"]],
  bodyText: JSON.stringify({
    success: false,
    error: "Desktop is not signed in.",
  }),
};
const OFFLINE_REPLY: CloudApiFetchResult = {
  kind: "network-error",
  message: "net::ERR_INTERNET_DISCONNECTED",
};

const MODES = [
  {
    mode: "signed out",
    auth: SIGNED_OUT,
    online: true,
    reply: SIGNED_OUT_REPLY,
  },
  { mode: "offline", auth: AUTHENTICATED, online: false, reply: OFFLINE_REPLY },
];

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);
const originalOnLine = Object.getOwnPropertyDescriptor(
  window.navigator,
  "onLine"
);

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    addEventListener: () => undefined,
    addListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: query,
    onchange: null,
    removeEventListener: () => undefined,
    removeListener: () => undefined,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  if (originalOnLine) {
    Object.defineProperty(window.navigator, "onLine", originalOnLine);
  } else {
    Reflect.deleteProperty(window.navigator, "onLine");
  }
});

describe("desktop comments without a local store (PLN-2162 M5.2)", {
  timeout: FLOW_TIMEOUT_MS,
}, () => {
  it.each(MODES)(
    "the legacy comments rail shows its failed-load state when $mode",
    async ({ auth, online, reply }) => {
      const desktop = setupDesktopApi(auth, online, reply);

      renderInDesktopShell(
        <BranchCommentsController
          activeTab={BranchCommentsTab.Details}
          detail={{ id: BRANCH_ID } as BranchPageDetail}
          onClose={vi.fn()}
          onJump={vi.fn()}
          open
          renderedSessionIds={[]}
          returnFocusRef={{ current: null }}
          selectedPullRequestKey="closedloop-ai/closedloop-ai#11213"
        />
      );

      await screen.findByRole(
        "heading",
        { name: `PR Comments ${COMMENTS_COUNT_UNAVAILABLE_LABEL}` },
        { timeout: SETTLE_TIMEOUT_MS }
      );
      expect(screen.getByRole("alert")).toBeDefined();
      expect(
        desktop.cloudApiFetch.mock.calls.some(([request]) =>
          request.path.startsWith(`/branches/${BRANCH_ID}/trace-comments`)
        )
      ).toBe(true);
    }
  );

  it.each(MODES)(
    "the unified comments pane shows its failed-load state when $mode",
    async ({ auth, online, reply }) => {
      const desktop = setupDesktopApi(auth, online, reply);

      renderInDesktopShell(
        <UnifiedPaneHost organizationId={auth.organizationId} />
      );

      await screen.findByText(
        COMMENTS_COUNT_UNAVAILABLE_LABEL,
        {},
        { timeout: SETTLE_TIMEOUT_MS }
      );
      expect(screen.getByRole("alert")).toBeDefined();
      expect(screen.queryAllByRole("group")).toHaveLength(0);
      expect(
        desktop.cloudApiFetch.mock.calls.some(
          ([request]) =>
            request.path === commentApiPaths.artifactComments(ARTIFACT_ID)
        )
      ).toBe(true);
    }
  );
});

/** The shape the M6 hosts take: the HTTP source and the hook, into the pane. */
function UnifiedPaneHost({
  organizationId,
}: Readonly<{ organizationId: string | null }>) {
  const comments = useArtifactComments(
    { id: ARTIFACT_ID },
    { dataSource: useHttpCommentsDataSource(), organizationId }
  );
  const { drafts, onDraftChange } = useCommentsPaneDrafts(ARTIFACT_ID);
  return (
    <CommentsPaneContent
      anchorStateLabels={NO_ANCHOR_STATE_LABELS}
      capabilities={comments.capabilities ?? READ_ONLY_CAPABILITIES}
      drafts={drafts}
      identity={ARTIFACT_ID}
      loadState={comments.loadState}
      onDraftChange={onDraftChange}
      onEdit={comments.onEdit}
      onRetryLoad={comments.onRetryLoad}
      pendingDraftKeys={comments.pendingDraftKeys}
      threads={comments.threads}
    />
  );
}

function renderInDesktopShell(children: ReactNode) {
  return render(
    <AppCoreStoryProviders>
      <DesktopAppCoreProvider>{children}</DesktopAppCoreProvider>
    </AppCoreStoryProviders>
  );
}

function setupDesktopApi(
  auth: DesktopAuthState,
  online: boolean,
  reply: CloudApiFetchResult
) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: online,
  });
  const cloudApiFetch = vi.fn(
    (_request: { path: string; method?: string; body?: string }) =>
      Promise.resolve(reply)
  );
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(auth)),
      onDesktopAuthStateChanged: vi.fn(() => () => undefined),
      cloudApiFetch,
    },
  });
  return { cloudApiFetch };
}
