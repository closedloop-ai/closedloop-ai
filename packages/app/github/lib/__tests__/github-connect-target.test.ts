import { describe, expect, it } from "vitest";
import { GitHubConnectAction } from "../github-connect-action";
import type { GitHubConnectTarget } from "../github-connect-target";

function acceptTarget(target: GitHubConnectTarget): GitHubConnectTarget {
  return target;
}

describe("GitHubConnectTarget", () => {
  it("permits an href-only target, with no onConnect key present", () => {
    const target = acceptTarget({
      action: GitHubConnectAction.Connect,
      href: "https://github.com/apps/closedloop/installations/new",
    });

    expect(target.action).toBe(GitHubConnectAction.Connect);
    expect(target.href).toBe(
      "https://github.com/apps/closedloop/installations/new"
    );
    expect(Object.hasOwn(target, "onConnect")).toBe(false);
  });

  it("permits an onConnect-only target, with no href key present", () => {
    const onConnect = () => {
      /* no-op for the test */
    };
    const target = acceptTarget({
      action: GitHubConnectAction.Reconnect,
      onConnect,
    });

    expect(target.action).toBe(GitHubConnectAction.Reconnect);
    expect(target.onConnect).toBe(onConnect);
    expect(Object.hasOwn(target, "href")).toBe(false);
  });

  it("rejects a target carrying both href and onConnect at compile time (FEA-3280)", () => {
    // The href/onConnect pairing is a discriminated union specifically so a
    // surface cannot carry both a navigation href AND a connect handler —
    // before ISS-5958 that ambiguity was resolved by an inert href winning
    // silently in the desktop renderer (a dead click). This must fail tsc.
    // @ts-expect-error — href and onConnect are mutually exclusive.
    const target: GitHubConnectTarget = {
      action: GitHubConnectAction.Connect,
      href: "https://github.com/apps/closedloop/installations/new",
      onConnect: () => {
        /* no-op for the test */
      },
    };

    // Even though tsc rejects the literal above, plain JS still constructs
    // the object — pin that the href half survived onto it either way.
    expect(target.href).toBe(
      "https://github.com/apps/closedloop/installations/new"
    );
  });
});
