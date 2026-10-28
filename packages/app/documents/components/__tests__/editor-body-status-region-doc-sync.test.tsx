import {
  type DocSyncConfig,
  DocSyncConfigContext,
} from "@repo/collaboration/client/doc-sync-config";
import { DocSyncRoom } from "@repo/collaboration/client/doc-sync-room";
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiError } from "../../../shared/api/api-error";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { EDITOR_LOAD_TIMEOUT_TITLE } from "../editor-body-load-failure";
import { EditorBodyStatusRegion } from "../editor-body-status-region";

/**
 * A doc-sync token mint the API refuses never becomes a room, so the region
 * states the failure as soon as the room gives up instead of after the
 * editor-ready timeout. Driven with the API client's real `ApiError`, because
 * that is the shape the room classifies.
 */
describe("EditorBodyStatusRegion under a DocSyncRoom", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("states the failure once the first mint is refused", async () => {
    const fetchToken = vi.fn(() =>
      Promise.reject(new ApiError("Forbidden", 403))
    );
    renderRegion(fetchToken);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeTruthy();
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  test("keeps waiting while a 503 mint backs off", async () => {
    vi.useFakeTimers();
    const fetchToken = vi.fn(() =>
      Promise.reject(new ApiError("Service Unavailable", 503))
    );
    renderRegion(fetchToken);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(screen.queryByText(EDITOR_LOAD_TIMEOUT_TITLE)).toBeNull();
    expect(fetchToken).toHaveBeenCalledTimes(2);
  });
});

function renderRegion(fetchToken: DocSyncConfig["fetchToken"]) {
  const config: DocSyncConfig = {
    fetchToken,
    self: null,
    resolveUser: () => undefined,
    mentionCandidates: [],
    maxMentionSuggestions: 6,
    renderMentionSuggestions: () => null,
  };
  return render(
    <AppCoreStoryProviders enabledFlags={[]}>
      <DocSyncConfigContext.Provider value={config}>
        <DocSyncRoom roomId="org-1:artifact:PRD-1">
          <EditorBodyStatusRegion hasTimedOut={false} isEditorReady={false} />
        </DocSyncRoom>
      </DocSyncConfigContext.Provider>
    </AppCoreStoryProviders>
  );
}
