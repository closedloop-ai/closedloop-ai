import { renderHook } from "@testing-library/react";
import type { AnyExtension } from "@tiptap/core";
import { Doc } from "yjs";

/**
 * Room-bound hook overrides that let the real `useLiveblocksExtension` run
 * without a Liveblocks room. Spread over `importOriginal()` in each test's
 * `vi.mock` factories (see `liveblocks-null-state-guards.test.tsx`).
 */
export const liveblocksReactOverrides = {
  useClient: () => ({}),
  useRoom: () => ({
    events: { self: { subscribe: () => () => undefined } },
    getSelf: () => null,
    id: "room-1",
  }),
};

export const liveblocksReactPrivateOverrides = {
  getUmbrellaStoreForClient: () => ({ outputs: { threads: {} } }),
  useCreateTextMention: () => () => undefined,
  useDeleteTextMention: () => () => undefined,
  useReportTextEditor: () => undefined,
  useYjsProvider: () => undefined,
};

type AddExtensionsContext = {
  storage: {
    doc: Doc;
    permanentUserData: undefined;
    provider: Record<string, never>;
    unsubs: (() => void)[];
  };
};

type AddExtensionsHandler = (this: AddExtensionsContext) => AnyExtension[];

/**
 * The extensions `useLiveblocksExtension()` adds to the editor, with its
 * default options. `addExtensions` reads only `this.storage`, so a stub stands
 * in for the Yjs provider the real `addStorage` would open.
 */
export async function resolveLiveblocksExtensions(): Promise<AnyExtension[]> {
  const { useLiveblocksExtension } = await import("@liveblocks/react-tiptap");
  const { result } = renderHook(() => useLiveblocksExtension({}));
  const addExtensions = result.current.config.addExtensions as unknown as
    | AddExtensionsHandler
    | undefined;
  if (!addExtensions) {
    throw new Error("liveblocksExtension defined no addExtensions");
  }
  return addExtensions.call({
    storage: {
      doc: new Doc(),
      permanentUserData: undefined,
      provider: {},
      unsubs: [],
    },
  });
}

export function findExtension(
  extensions: readonly AnyExtension[],
  name: string
): AnyExtension {
  const extension = extensions.find((candidate) => candidate.name === name);
  if (!extension) {
    throw new Error(`Liveblocks added no "${name}" extension`);
  }
  return extension;
}
