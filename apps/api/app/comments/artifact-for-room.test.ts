import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";

const withDb = vi.hoisted(() => vi.fn());

vi.mock("@repo/database", () => ({ withDb }));

import { findArtifactForRoom } from "./artifact-for-room";

const ARTIFACT_ROOM_ID = generateDocumentRoomId("org-1", "PRD-7");

beforeEach(() => {
  withDb.mockReset();
});

describe("findArtifactForRoom", () => {
  it("returns null for a room id that is not an artifact room, without a lookup", async () => {
    await expect(
      findArtifactForRoom("org-1", "not-an-artifact-room")
    ).resolves.toBeNull();
    expect(withDb).not.toHaveBeenCalled();
  });

  it("returns null when no artifact matches the room's slug", async () => {
    withDb.mockResolvedValue(null);

    await expect(
      findArtifactForRoom("org-1", ARTIFACT_ROOM_ID)
    ).resolves.toBeNull();
  });

  it("rethrows a failed lookup instead of reporting the room as unresolvable", async () => {
    const failure = new Error("connection terminated");
    withDb.mockRejectedValue(failure);

    await expect(findArtifactForRoom("org-1", ARTIFACT_ROOM_ID)).rejects.toBe(
      failure
    );
  });
});
