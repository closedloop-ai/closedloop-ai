import type { DocumentDetail } from "@repo/api/src/types/document";
import { DocumentType } from "@repo/api/src/types/document";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  EDITOR_READY_TIMEOUT_MS,
  useEditorSession,
} from "../use-editor-session";

/**
 * ISS-7058. `isEditorReady` is set from exactly one place on the Liveblocks
 * path — the Y.Doc sync callback — so a room that never syncs leaves it false
 * forever. The scaffold hides the editor body while it is false, so without a
 * timeout the user gets an invisible zero-height body and no error, on every
 * PRD/ISS/Plan detail screen. These pin the timeout that turns that silence
 * into a stated failure.
 */
function createArtifact(latestVersion = 1): DocumentDetail {
  const now = new Date("2026-06-12T00:00:00.000Z");
  return {
    id: "document-1",
    organizationId: "org-1",
    projectId: "project-1",
    type: DocumentType.Prd,
    title: "Timeout doc",
    slug: "PRD-1",
    fileName: null,
    status: "DRAFT",
    priority: "MEDIUM",
    latestVersion,
    latestVersionContent: "",
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
      id: "version-1",
      documentId: "document-1",
      version: 1,
      content: "",
      createdById: "user-1",
      createdAt: now,
    },
  };
}

function renderSession() {
  return renderHook(() =>
    useEditorSession({ artifact: createArtifact(), currentVersion: 1 })
  );
}

describe("useEditorSession editor-ready timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-12T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("does not claim failure while the editor is still within its window", () => {
    const { result } = renderSession();
    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS - 1);
    });
    expect(result.current.isEditorReady).toBe(false);
    expect(result.current.hasEditorReadyTimedOut).toBe(false);
  });

  test("reports a failure once the editor never becomes ready", () => {
    const { result } = renderSession();
    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS);
    });
    expect(result.current.hasEditorReadyTimedOut).toBe(true);
  });

  test("never reports a failure for an editor that became ready in time", () => {
    const { result } = renderSession();
    act(() => {
      result.current.handleEditorReady();
    });
    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS * 4);
    });
    expect(result.current.isEditorReady).toBe(true);
    expect(result.current.hasEditorReadyTimedOut).toBe(false);
  });

  test("takes the failure back when the editor turns up late", () => {
    const { result } = renderSession();
    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS);
    });
    expect(result.current.hasEditorReadyTimedOut).toBe(true);
    act(() => {
      result.current.handleEditorReady();
    });
    expect(result.current.hasEditorReadyTimedOut).toBe(false);
  });

  // The scaffold remounts the editor subtree on `key={currentVersion}` while
  // the containers switch versions without remounting the scaffold, so the
  // version the user selects gets a brand-new Y.Doc sync. Readiness latched by
  // the PREVIOUS version says nothing about it — and if it carried over, the
  // timeout never armed and a failed resync was silent again, which is the whole
  // defect this PR exists to remove.
  test("arms a fresh timeout for the version the user switches to", () => {
    const { rerender, result } = renderHook(
      ({ currentVersion }) =>
        useEditorSession({ artifact: createArtifact(2), currentVersion }),
      { initialProps: { currentVersion: 2 } }
    );
    act(() => {
      result.current.handleEditorReady();
    });
    expect(result.current.isEditorReady).toBe(true);

    rerender({ currentVersion: 1 });
    expect(result.current.isEditorReady).toBe(false);

    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS);
    });
    expect(result.current.hasEditorReadyTimedOut).toBe(true);
  });

  // Returning to a version that once succeeded is still a fresh mount, so its
  // readiness has to be re-earned rather than resurrected.
  test("does not resurrect readiness when the user switches back", () => {
    const { rerender, result } = renderHook(
      ({ currentVersion }) =>
        useEditorSession({ artifact: createArtifact(2), currentVersion }),
      { initialProps: { currentVersion: 2 } }
    );
    act(() => {
      result.current.handleEditorReady();
    });

    rerender({ currentVersion: 1 });
    rerender({ currentVersion: 2 });
    expect(result.current.isEditorReady).toBe(false);
  });

  // A verdict belongs to the version that earned it. Carrying a failure into
  // the next version would condemn it before its own window had even opened.
  test("does not carry a failure verdict into the next version", () => {
    const { rerender, result } = renderHook(
      ({ currentVersion }) =>
        useEditorSession({ artifact: createArtifact(2), currentVersion }),
      { initialProps: { currentVersion: 2 } }
    );
    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS);
    });
    expect(result.current.hasEditorReadyTimedOut).toBe(true);

    rerender({ currentVersion: 1 });
    expect(result.current.hasEditorReadyTimedOut).toBe(false);
  });

  test("clears the pending timer on unmount", () => {
    const { result, unmount } = renderSession();
    unmount();
    act(() => {
      vi.advanceTimersByTime(EDITOR_READY_TIMEOUT_MS * 2);
    });
    expect(result.current.hasEditorReadyTimedOut).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
