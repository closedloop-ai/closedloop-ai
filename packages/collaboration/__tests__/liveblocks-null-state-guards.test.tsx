// @vitest-environment jsdom

/**
 * ISS-9849: both cases here crash inside `@liveblocks/react-tiptap` itself, so
 * they are guarded by `patches/@liveblocks__react-tiptap@3.18.5.patch` and can
 * only be pinned by executing the library's own code. The composer crash also
 * has a repo-side cause, and the mount gate in `editor-with-anchored-comments`
 * is the fix for it — this patch is the backstop under that gate, kept because
 * both defects are still present upstream. Every `vi.mock` below is
 * therefore a dependency of the patched modules, never the patched module
 * itself — importing a mock of `@liveblocks/react-tiptap` would assert nothing.
 * Both defects are still present in the latest upstream (3.24.1), so the patch
 * is not a stopgap waiting on a version bump.
 */

import { renderHook } from "@testing-library/react";
import type { Editor } from "@tiptap/core";
import { describe, expect, it, vi } from "vitest";

const LOCAL_USER = { name: "Ada", color: "#ff0000" } as const;

const { mockUseEditorState } = vi.hoisted(() => ({
  mockUseEditorState: vi.fn(),
}));

vi.mock("@tiptap/react", () => ({
  useEditorState: mockUseEditorState,
}));

// Partial mocks throughout: the package barrel pulls in its whole surface
// (AI toolbar, version history), so replacing a module wholesale strands
// exports these tests never touch. Only the room-bound hooks are overridden.
vi.mock("@liveblocks/react", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useClient: () => ({}),
  useCreateThread: () => vi.fn(),
  useRoom: () => ({
    events: { self: { subscribe: () => () => undefined } },
    getSelf: () => ({ id: "user-1", info: LOCAL_USER }),
    id: "room-1",
  }),
}));

vi.mock("@liveblocks/react/_private", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getUmbrellaStoreForClient: () => ({ outputs: { threads: {} } }),
  useCreateTextMention: () => vi.fn(),
  useDeleteTextMention: () => vi.fn(),
  useReportTextEditor: () => undefined,
  useYjsProvider: () => undefined,
}));

vi.mock("@liveblocks/yjs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getYjsProviderForRoom: () => ({}),
}));

type SelectorContext = {
  editor: {
    state: { selection: { empty: boolean } };
    storage: Record<string, unknown>;
  };
};

type PendingCommentSelector = (
  ctx: SelectorContext
) => { empty: boolean } | undefined;

/**
 * Renders the real `FloatingComposer` far enough to capture the selector it
 * hands `useEditorState`. The selector is the frame RUM reported, so driving
 * it directly is what proves the guard rather than the render path around it.
 */
async function captureFloatingComposerSelector(): Promise<PendingCommentSelector> {
  const { FloatingComposer } = await import("@liveblocks/react-tiptap");
  const { render } = await import("@testing-library/react");
  mockUseEditorState.mockReturnValue(undefined);
  const editor = {
    state: { selection: { empty: true } },
    storage: {},
  } as unknown as Editor;
  render(<FloatingComposer editor={editor} />);
  const call = mockUseEditorState.mock.calls.at(-1);
  if (!call) {
    throw new Error("FloatingComposer never reached useEditorState");
  }
  return (call[0] as { selector: PendingCommentSelector }).selector;
}

describe("FloatingComposer pending-comment selector (ISS-9849)", () => {
  it("returns no pending selection when the comments storage namespace is absent", async () => {
    const selector = await captureFloatingComposerSelector();

    expect(() =>
      selector({
        editor: { state: { selection: { empty: false } }, storage: {} },
      })
    ).not.toThrow();
    expect(
      selector({
        editor: { state: { selection: { empty: false } }, storage: {} },
      })
    ).toBeUndefined();
  });

  it("still reports the selection when the namespace carries a pending comment", async () => {
    const selector = await captureFloatingComposerSelector();
    const selection = { empty: false };

    expect(
      selector({
        editor: {
          state: { selection },
          storage: { liveblocksComments: { pendingComment: true } },
        },
      })
    ).toBe(selection);
  });
});

type OnCreateContext = {
  editor: {
    commands: { updateUser: ReturnType<typeof vi.fn> };
    extensionManager: { extensions: never[] };
    options: Record<string, never>;
  };
  storage: {
    doc: { clientID: number };
    permanentUserData: undefined;
    provider: { awareness: { getLocalState: () => { user?: unknown } | null } };
    unsubs: (() => void)[];
  };
};

function onCreateContext(
  getLocalState: () => { user?: unknown } | null
): OnCreateContext {
  return {
    editor: {
      commands: { updateUser: vi.fn() },
      extensionManager: { extensions: [] },
      options: {},
    },
    storage: {
      doc: { clientID: 1 },
      permanentUserData: undefined,
      provider: { awareness: { getLocalState } },
      unsubs: [],
    },
  };
}

/**
 * Tiptap types `onCreate`'s `this` as the full extension context, but the body
 * under test reads only `editor` and `storage`, so the test supplies those two
 * and narrows the handler to match.
 */
type OnCreateHandler = (
  this: OnCreateContext,
  event: { editor: OnCreateContext["editor"] }
) => void;

function callOnCreate(
  extension: { config: { onCreate?: unknown } },
  ctx: OnCreateContext
): void {
  const onCreate = extension.config.onCreate as unknown as
    | OnCreateHandler
    | undefined;
  if (!onCreate) {
    throw new Error("liveblocksExtension defined no onCreate handler");
  }
  onCreate.call(ctx, { editor: ctx.editor });
}

/**
 * `onCreate` is the frame RUM reported. It closes over the room and options
 * from the hook, so the extension has to come from the real hook, but its
 * `this` is supplied here — the extension's own `addStorage` never runs, which
 * is what keeps the Yjs provider out of the test.
 */
async function createLiveblocksExtension() {
  const { useLiveblocksExtension } = await import("@liveblocks/react-tiptap");
  const { result } = renderHook(() =>
    useLiveblocksExtension({ comments: false })
  );
  return result.current;
}

describe("Liveblocks extension awareness read (ISS-9849)", () => {
  /**
   * `y-protocols` seeds `setLocalState({})` in its constructor, so a null
   * `getLocalState()` means the provider awareness was DESTROYED, not that it
   * is not yet established. This case pins that `onCreate` survives that and
   * still reaches the identity-sync command. It does NOT claim the identity is
   * written: downstream `setLocalStateField` no-ops while local state is null,
   * so on a torn-down provider that dispatch is inert by design.
   */
  it("completes onCreate and still reaches the identity sync when awareness was destroyed", async () => {
    const extension = await createLiveblocksExtension();
    const ctx = onCreateContext(() => null);

    expect(() => callOnCreate(extension, ctx)).not.toThrow();
    expect(ctx.editor.commands.updateUser).toHaveBeenCalledWith(LOCAL_USER);
  });

  it("leaves the stored identity alone when awareness already matches", async () => {
    const extension = await createLiveblocksExtension();
    const ctx = onCreateContext(() => ({ user: { ...LOCAL_USER } }));

    expect(() => callOnCreate(extension, ctx)).not.toThrow();
    expect(ctx.editor.commands.updateUser).not.toHaveBeenCalled();
  });
});
