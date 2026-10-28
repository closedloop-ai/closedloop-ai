import { CollaborationProviderWrapper } from "@repo/app/documents/components/collaboration-provider-wrapper";
import { MAX_MENTION_SUGGESTIONS } from "@repo/app/shared/components/mention-suggestion-list";
import {
  type DocSyncConfig,
  DocSyncConfigContext,
} from "@repo/collaboration/client/doc-sync-config";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { getConsistentColor } from "@repo/collaboration/shared/user-colors";
import { DOC_SYNC_TOKEN_PATH } from "@repo/realtime-contract/protocol";
import { render, screen, within } from "@testing-library/react";
import { type ReactNode, useContext } from "react";
import { beforeEach, describe, expect, onTestFinished, test, vi } from "vitest";

/**
 * PLN-2189 T-3.1: the wrapper that mounts on web (`layout.tsx`) and desktop
 * (`desktop-document-detail-view.tsx`) hands every `DocSyncRoom` its token
 * minting and identity.
 */
const postMock = vi.fn();

vi.mock("@repo/collaboration/client/top-level-collaboration-provider", () => ({
  TopLevelCollaborationProvider: ({ children }: { children: ReactNode }) =>
    children,
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => ({
    data: { id: "user-1", organizationId: "org-1" },
    isLoading: false,
  }),
  useOrganizationUsers: () => ({
    data: [
      {
        id: "user-2",
        firstName: "Grace",
        lastName: "Hopper",
        email: "grace@example.com",
        avatarUrl: "https://img.example/g.png",
        active: true,
      },
      {
        id: "user-3",
        firstName: null,
        lastName: null,
        email: "nameless@example.com",
        avatarUrl: null,
        active: true,
      },
    ],
  }),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ post: postMock, postRaw: vi.fn() }),
}));

const ROOM = generateDocumentRoomId("org-1", "PRD-1");
const GRACE_ROW = /Grace Hopper/;
const NAMELESS_ROW = /nameless@example\.com/;

describe("CollaborationProviderWrapper doc-sync config", () => {
  beforeEach(() => {
    postMock.mockReset();
  });

  test("mints a doc-sync token for the room it is asked about", async () => {
    const issued = {
      token: "signed",
      expiresAt: 1_800_000_000_000,
      url: "wss://doc-sync.example",
    };
    postMock.mockResolvedValue(issued);

    await expect(renderConfig().fetchToken(ROOM)).resolves.toEqual(issued);
    expect(postMock).toHaveBeenCalledWith(DOC_SYNC_TOKEN_PATH, { room: ROOM });
  });

  // DocSyncRoom validates the body and stops on a malformed one
  // (doc-sync-room.test.tsx); the hook hands it over unparsed.
  test("passes a malformed token body through to the room", async () => {
    const malformed = { token: 42, expiresAt: "soon" };
    postMock.mockResolvedValue(malformed);

    await expect(renderConfig().fetchToken(ROOM)).resolves.toEqual(malformed);
  });

  test("identifies the user and resolves peers from the org user list", () => {
    const config = renderConfig();

    expect(config.self).toEqual({
      id: "user-1",
      color: getConsistentColor("user-1"),
    });
    expect(config.resolveUser("user-2")).toEqual({
      name: "Grace Hopper",
      avatarUrl: "https://img.example/g.png",
    });
    expect(config.resolveUser("user-3")).toEqual({
      name: "nameless@example.com",
      avatarUrl: undefined,
    });
    expect(config.resolveUser("user-404")).toBeUndefined();
    expect(config.mentionCandidates.map((user) => user.id)).toEqual([
      "user-2",
      "user-3",
    ]);
  });

  // PLN-2189 T-2.8: the body picker shows the comment composer's list and cap.
  test("hands the body mention picker the composer's suggestion list and cap", () => {
    const config = renderConfig();
    const [first, second] = config.mentionCandidates;
    if (!(first && second)) {
      throw new Error("expected two candidates");
    }
    // jsdom has no `scrollIntoView`, which the list calls on the active row.
    const scrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView"
    );
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    onTestFinished(() => {
      if (scrollIntoView) {
        Object.defineProperty(
          Element.prototype,
          "scrollIntoView",
          scrollIntoView
        );
      } else {
        Reflect.deleteProperty(Element.prototype, "scrollIntoView");
      }
    });
    const container = document.createElement("div");
    document.body.append(container);
    onTestFinished(() => container.remove());

    render(
      config.renderMentionSuggestions({
        suggestions: [first, second],
        activeIndex: 1,
        anchorRect: new DOMRect(40, 100, 0, 16),
        onSelect: vi.fn(),
        container,
      })
    );

    expect(config.maxMentionSuggestions).toBe(MAX_MENTION_SUGGESTIONS);
    const list = screen.getByRole("listbox");
    expect(list.parentElement).toBe(container);
    expect(
      within(list).getByRole("option", { name: GRACE_ROW })
    ).toHaveAttribute("aria-selected", "false");
    expect(
      within(list).getByRole("option", { name: NAMELESS_ROW })
    ).toHaveAttribute("aria-selected", "true");
    // A caret has no width: the menu keeps its own instead of collapsing.
    expect(list.style.width).toBe("288px");
  });
});

function renderConfig(): DocSyncConfig {
  const seen: { config: DocSyncConfig | null } = { config: null };
  function Probe() {
    seen.config = useContext(DocSyncConfigContext);
    return null;
  }
  render(
    <CollaborationProviderWrapper>
      <Probe />
    </CollaborationProviderWrapper>
  );
  if (!seen.config) {
    throw new Error("the wrapper provided no doc-sync config");
  }
  return seen.config;
}
