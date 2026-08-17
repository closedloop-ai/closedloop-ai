import { describe, expect, it } from "vitest";

import { LoopCommand } from "../src/commands";
import {
  getMultiRepoPolicy,
  PeerWriteMode,
  WorktreeFreshness,
} from "../src/multi-repo-policy";

describe("getMultiRepoPolicy", () => {
  it("returns the writable policy for execution", () => {
    expect(getMultiRepoPolicy(LoopCommand.Execute)).toEqual({
      supportsAdditionalRepos: true,
      peerWriteMode: PeerWriteMode.ReadWrite,
      worktreeFreshness: WorktreeFreshness.ReuseStale,
    });
  });

  it("fails closed for a future command", () => {
    expect(getMultiRepoPolicy("future_command")).toEqual({
      supportsAdditionalRepos: false,
      peerWriteMode: PeerWriteMode.ReadOnly,
      worktreeFreshness: WorktreeFreshness.AlwaysFresh,
    });
  });
});
