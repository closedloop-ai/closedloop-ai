import { GitHubConnectAction } from "@repo/app/github/lib/github-connect-action";
import type { GitHubConnectTarget } from "@repo/app/github/lib/github-connect-target";
import { describe, expect, it, vi } from "vitest";
import { branchesSummaryConnectAsk } from "../branches-summary-connect-ask";

/**
 * marisolashgrove, ISS-12638: the strip's ask is keyed on the producer's own
 * bundle, never on an availability bucket the local fallback also writes.
 */

const TARGET: GitHubConnectTarget = {
  action: GitHubConnectAction.Connect,
  onConnect: vi.fn(),
};

describe("branchesSummaryConnectAsk", () => {
  it("offers the host's target for a disconnected reader on the producer's bundle", () => {
    expect(
      branchesSummaryConnectAsk({
        connectAction: GitHubConnectAction.Connect,
        connectTarget: TARGET,
        metricsDerivedLocally: false,
      })
    ).toBe(TARGET);
  });

  it("withholds it when the local fallback authored the figures", () => {
    expect(
      branchesSummaryConnectAsk({
        connectAction: GitHubConnectAction.Connect,
        connectTarget: TARGET,
        metricsDerivedLocally: true,
      })
    ).toBeUndefined();
  });

  it("withholds it when no action resolved — connected, or a status still in flight", () => {
    expect(
      branchesSummaryConnectAsk({
        connectAction: null,
        connectTarget: TARGET,
        metricsDerivedLocally: false,
      })
    ).toBeUndefined();
  });

  it("offers a reconnect the same way, so the second verb is not a second gate", () => {
    expect(
      branchesSummaryConnectAsk({
        connectAction: GitHubConnectAction.Reconnect,
        connectTarget: TARGET,
        metricsDerivedLocally: false,
      })
    ).toBe(TARGET);
  });
});
