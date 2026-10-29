import { describe, expect, it } from "vitest";
import { SessionsListReadState } from "../../../lib/sessions-list-read-state";
import { resolveSessionsListSurfaceReadState } from "../sessions-list-surface-paging";

describe("resolveSessionsListSurfaceReadState", () => {
  it("keeps a pending uncontrolled read ahead of cached error flags", () => {
    expect(
      resolveSessionsListSurfaceReadState({
        isError: true,
        isPending: true,
        isPlaceholderPage: false,
        isServerDriven: true,
        isSyncing: false,
      })
    ).toBe(SessionsListReadState.Loading);
  });

  it("keeps a syncing uncontrolled read ahead of cached error flags", () => {
    expect(
      resolveSessionsListSurfaceReadState({
        isError: true,
        isPending: false,
        isPlaceholderPage: false,
        isServerDriven: true,
        isSyncing: true,
      })
    ).toBe(SessionsListReadState.Syncing);
  });

  it("preserves a controlled read state as the host authority", () => {
    expect(
      resolveSessionsListSurfaceReadState({
        controlledReadState: SessionsListReadState.Unavailable,
        isError: false,
        isPending: true,
        isPlaceholderPage: false,
        isServerDriven: true,
        isSyncing: true,
      })
    ).toBe(SessionsListReadState.Unavailable);
  });

  it("maps a failed uncontrolled read to the complete-surface error state", () => {
    expect(
      resolveSessionsListSurfaceReadState({
        isError: true,
        isPending: false,
        isPlaceholderPage: false,
        isServerDriven: true,
        isSyncing: false,
      })
    ).toBe(SessionsListReadState.Error);
  });
});
