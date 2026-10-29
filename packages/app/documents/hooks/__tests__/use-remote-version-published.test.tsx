import type { DocumentDetail } from "@repo/api/src/types/document";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRemoteVersionPublished } from "../use-remote-version-published";

const mocks = vi.hoisted(() => ({ onDocSync: false, toast: vi.fn() }));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => mocks.onDocSync,
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: (message: string) => mocks.toast(message),
}));

function documentAt(latestVersion: number): DocumentDetail {
  return {
    id: "doc-1",
    latestVersion,
    version: { content: `content v${latestVersion}`, version: latestVersion },
  } as DocumentDetail;
}

function publishV6() {
  const onVersionChange = vi.fn();
  const setEditorContent = vi.fn();
  const { result } = renderHook(() =>
    useRemoteVersionPublished({
      document: documentAt(5),
      currentVersion: 5,
      onVersionChange,
      setEditorContent,
    })
  );
  act(() => result.current.handleRemoteVersionPublished(documentAt(6)));
  return { onVersionChange, setEditorContent };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRemoteVersionPublished", () => {
  it("on doc-sync, advances to a newer version and never rewrites the editor", () => {
    mocks.onDocSync = true;

    const { onVersionChange, setEditorContent } = publishV6();

    expect(onVersionChange).toHaveBeenCalledWith(6);
    expect(setEditorContent).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });

  it("on Liveblocks, advances and reseeds the editor with the new content", () => {
    mocks.onDocSync = false;

    const { onVersionChange, setEditorContent } = publishV6();

    expect(onVersionChange).toHaveBeenCalledWith(6);
    expect(setEditorContent).toHaveBeenCalledWith("content v6");
  });
});
