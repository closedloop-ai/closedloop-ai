import { describe, expect, it, vi } from "vitest";
import {
  type ComputeTargetsSnapshotClient,
  fetchComputeTargetsSnapshot,
} from "../compute-targets-snapshot";

const WIRE_TARGET = {
  id: "target-1",
  lastSeenAt: "2026-05-10T12:00:00.000Z",
  createdAt: "2026-05-08T09:00:00.000Z",
  updatedAt: "2026-05-09T10:00:00.000Z",
};

function snapshotClient(): ComputeTargetsSnapshotClient {
  return { get: vi.fn().mockResolvedValue([WIRE_TARGET]) };
}

describe("fetchComputeTargetsSnapshot", () => {
  it("materializes the wire timestamps as Dates", async () => {
    const client = snapshotClient();

    const targets = await fetchComputeTargetsSnapshot(client);

    expect(client.get).toHaveBeenCalledWith("/compute-targets");
    expect(targets[0]?.lastSeenAt).toEqual(new Date(WIRE_TARGET.lastSeenAt));
    expect(targets[0]?.createdAt).toEqual(new Date(WIRE_TARGET.createdAt));
    expect(targets[0]?.updatedAt).toEqual(new Date(WIRE_TARGET.updatedAt));
  });
});
