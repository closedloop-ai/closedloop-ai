import type { DocumentDetail } from "@repo/api/src/types/document";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentContent } from "../use-document-content";

const mocks = vi.hoisted(() => ({
  onDocSync: false,
  post: vi.fn(),
}));

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: () => mocks.onDocSync,
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ post: mocks.post }),
}));

vi.mock("@repo/design-system/components/ui/sonner", () => ({
  toast: { info: vi.fn(), success: vi.fn() },
}));

const VERSION_CONTENT = "# Version 3";
const VERSIONS_PATH = "/documents/doc-1/versions";
const LIVE_DRAFT_RESET_PATH = "/documents/doc-1/live-draft/reset";

function artifact(): DocumentDetail {
  return {
    id: "doc-1",
    slug: "PRD-1",
    latestVersion: 4,
    version: { content: VERSION_CONTENT, version: 3 },
  } as DocumentDetail;
}

function mount(isLatestVersion: boolean) {
  const setEditorContent = vi.fn();
  const { result } = renderHook(
    () =>
      useDocumentContent({
        artifact: artifact(),
        isLatestVersion,
        setEditorContent,
      }),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
  return { result, setEditorContent };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.post.mockResolvedValue({
    ...artifact(),
    version: { content: "published", version: 5 },
  });
});

describe("restoreVersion on doc-sync", () => {
  beforeEach(() => {
    mocks.onDocSync = true;
  });

  it("resets the live draft on the server for the latest version, never in the browser", async () => {
    const { result, setEditorContent } = mount(true);

    act(() => result.current.restoreVersion());

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(LIVE_DRAFT_RESET_PATH, {})
    );
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(setEditorContent).not.toHaveBeenCalled();
  });

  it("publishes a historical version with reset-room=true, never rewriting the editor", async () => {
    const { result, setEditorContent } = mount(false);

    act(() => result.current.restoreVersion());

    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        `${VERSIONS_PATH}?reset-room=true`,
        { content: VERSION_CONTENT }
      )
    );
    await waitFor(() => expect(mocks.post).toHaveBeenCalledTimes(1));
    expect(setEditorContent).not.toHaveBeenCalled();
  });

  it("does not reseed the editor after a publish", async () => {
    const onSuccess = vi.fn();
    const { result, setEditorContent } = mount(true);

    act(() => result.current.saveContent("edited", true, onSuccess));

    await waitFor(() => expect(onSuccess).toHaveBeenCalledOnce());
    expect(setEditorContent).not.toHaveBeenCalled();
  });
});

describe("restoreVersion on Liveblocks", () => {
  beforeEach(() => {
    mocks.onDocSync = false;
  });

  it("reseeds the editor in the browser for the latest version, with no request", () => {
    const { result, setEditorContent } = mount(true);

    act(() => result.current.restoreVersion());

    expect(setEditorContent).toHaveBeenCalledWith(VERSION_CONTENT);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("reseeds the editor and publishes a historical version", async () => {
    const { result, setEditorContent } = mount(false);

    act(() => result.current.restoreVersion());

    expect(setEditorContent).toHaveBeenCalledWith(VERSION_CONTENT);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(
        `${VERSIONS_PATH}?reset-room=true`,
        { content: VERSION_CONTENT }
      )
    );
  });

  it("reseeds the editor with the published content after a publish", async () => {
    const { result, setEditorContent } = mount(true);

    act(() => result.current.saveContent("edited", true));

    await waitFor(() =>
      expect(setEditorContent).toHaveBeenCalledWith("published")
    );
  });
});
