import { describe, expect, it } from "vitest";
import {
  type MonitoredActivityTarget,
  monitoredActivityTargetKey,
  monitoredActivityTargetUrl,
} from "./monitored-activity-target.ts";
import { ArtifactRefTargetKind } from "./session-artifact-link.ts";

describe("monitoredActivityTargetKey", () => {
  it("keys a branch target by kind, repository and branch name", () => {
    const target: MonitoredActivityTarget = {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/iss-9860",
    };
    expect(monitoredActivityTargetKey(target)).toBe(
      "branch:closedloop-ai/closedloop-ai:feat/iss-9860"
    );
  });

  it("keys a pull-request target by kind, repository and number", () => {
    const target: MonitoredActivityTarget = {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 7113,
    };
    expect(monitoredActivityTargetKey(target)).toBe(
      "pull_request:closedloop-ai/closedloop-ai#7113"
    );
  });

  it("separates a branch and a PR that share a repository and a name-like value", () => {
    const branch = monitoredActivityTargetKey({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "acme/repo",
      branchName: "42",
    });
    const pullRequest = monitoredActivityTargetKey({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "acme/repo",
      prNumber: 42,
    });
    expect(branch).not.toBe(pullRequest);
  });
});

/**
 * The producer controls every character of `repositoryFullName` and
 * `branchName` — the wire schemas bound only their length — so these pin the
 * derivation's anti-forgery claim rather than its formatting.
 *
 * Every case that expects a link RESOLVES it through `new URL`, because the
 * whole defect class here is a string that reads correctly and a resolver that
 * disagrees: `".."` produced the perfectly ordinary-looking
 * `https://github.com/../pull/5`, whose pathname is `/pull/5`.
 */
describe("monitoredActivityTargetUrl", () => {
  it("leaves an ordinary owner/repo target unescaped", () => {
    const pullRequest = monitoredActivityTargetUrl({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      prNumber: 7113,
    });
    const branch = monitoredActivityTargetUrl({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "closedloop-ai/closedloop-ai",
      branchName: "feat/iss-9182",
    });

    expect(resolvedUrl(pullRequest).pathname).toBe(
      "/closedloop-ai/closedloop-ai/pull/7113"
    );
    expect(resolvedUrl(branch).pathname).toBe(
      "/closedloop-ai/closedloop-ai/tree/feat%2Fiss-9182"
    );
  });

  it("escapes a repository name that would otherwise end the path", () => {
    // Resolved, not compared as a string: an unescaped `?` or `#` would move
    // those characters OUT of the pathname, which only the parser can show.
    expect(
      resolvedUrl(
        monitoredActivityTargetUrl({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: "acme/repo?x=1",
          prNumber: 5,
        })
      ).pathname
    ).toBe("/acme/repo%3Fx%3D1/pull/5");
    expect(
      resolvedUrl(
        monitoredActivityTargetUrl({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: "acme/repo#frag",
          prNumber: 5,
        })
      ).pathname
    ).toBe("/acme/repo%23frag/pull/5");
  });

  it("denies a dot segment the boundary it would walk another repository with", () => {
    const url = monitoredActivityTargetUrl({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "acme/repo/../../attacker/evil",
      prNumber: 5,
    });

    expect(resolvedUrl(url).pathname).toBe(
      "/acme%2Frepo%2F..%2F..%2Fattacker%2Fevil/pull/5"
    );
  });

  it("keeps a dot-segment branch name inside the repository the target named", () => {
    const url = monitoredActivityTargetUrl({
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: "acme/repo",
      branchName: "../../attacker/evil",
    });

    expect(resolvedUrl(url).pathname).toBe(
      "/acme/repo/tree/..%2F..%2Fattacker%2Fevil"
    );
  });

  it("keeps a repository name whose LAST SEGMENT is only dots out of the path structure", () => {
    const url = monitoredActivityTargetUrl({
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: "acme/..",
      prNumber: 5,
    });

    expect(resolvedUrl(url).pathname).toBe("/acme%2F../pull/5");
  });

  it.each([".", ".."])(
    "gives a repository name that is ENTIRELY the dot segment %j no link at all",
    (repositoryFullName) => {
      // The collapse the case above relies on buys nothing here: there is no
      // boundary left to deny, so the parser erases the only segment and
      // promotes `/pull/5` to the front — a link naming the repository
      // `pull/5`, which the target never mentioned. No escaping survives that,
      // so the derivation reports no location rather than the wrong one.
      expect(
        monitoredActivityTargetUrl({
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName,
          prNumber: 5,
        })
      ).toBeUndefined();
    }
  );

  it("gives a dot-segment repository AND branch no link, rather than github.com itself", () => {
    expect(
      monitoredActivityTargetUrl({
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "..",
        branchName: "..",
      })
    ).toBeUndefined();
  });

  it.each(["...", "%2e%2e"])(
    "still links a repository name the parser does NOT erase: %j",
    (repositoryFullName) => {
      // The counterfactual for the two cases above. Three dots is not a dot
      // segment, and a literal `%2e%2e` is escaped to `%252e%252e` before the
      // parser ever sees it — both 404 while naming what the target claimed, so
      // refusing them would withhold a link the inputs fully support.
      const url = monitoredActivityTargetUrl({
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName,
        prNumber: 5,
      });

      expect(resolvedUrl(url).pathname).toBe(
        `/${encodeURIComponent(repositoryFullName)}/pull/5`
      );
    }
  );

  it("gives an empty repository name no link", () => {
    expect(
      monitoredActivityTargetUrl({
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "",
        prNumber: 5,
      })
    ).toBeUndefined();
  });

  it("answers rather than throws for a name UTF-8 cannot encode", () => {
    // `encodeURIComponent` raises `URIError` on a LONE surrogate, and JSON
    // admits one. This runs inside the sync write transaction, so a throw here
    // is a poison pill that rolls back the delivery and repeats on every
    // redelivery — the failure class ISS-9182 exists to remove.
    const pullRequest = () =>
      monitoredActivityTargetUrl({
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: `acme/re${LONE_SURROGATE}po`,
        prNumber: 5,
      });
    const branch = () =>
      monitoredActivityTargetUrl({
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "acme/repo",
        branchName: `feat/${LONE_SURROGATE}broken`,
      });

    expect(pullRequest).not.toThrow();
    expect(branch).not.toThrow();
    expect(pullRequest()).toBeUndefined();
    expect(branch()).toBeUndefined();
  });

  it("keeps the origin on a repository name that looks like a url", () => {
    const resolved = resolvedUrl(
      monitoredActivityTargetUrl({
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: "https://evil.example/x",
        prNumber: 5,
      })
    );

    expect(resolved.origin).toBe("https://github.com");
    // The whole name lands in ONE segment: the `//` never becomes an authority
    // and the scheme never becomes a scheme.
    expect(resolved.pathname).toBe("/https%3A%2F%2Fevil.example%2Fx/pull/5");
  });
});

/**
 * The href a browser would actually resolve. Every assertion about a link goes
 * through this rather than comparing the returned string, because the returned
 * string is exactly what looked right while the resolver disagreed: `".."`
 * produced `https://github.com/../pull/5`, whose pathname is `/pull/5`.
 *
 * Throws rather than asserting, so a case that expects a link and gets none
 * fails on this line instead of on an opaque parse error further down.
 */
function resolvedUrl(url: string | undefined): URL {
  if (url === undefined) {
    throw new Error("expected a resolvable link, got none");
  }
  return new URL(url);
}

/** An unpaired high surrogate: valid JSON, no UTF-8 encoding. */
const LONE_SURROGATE = "\uD800";
