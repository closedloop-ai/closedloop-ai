import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { AgentComponentInvocationKind } from "@repo/api/src/types/agent-component-invocation";
import type { NormalizedSession } from "@repo/lib/harness/types";
import { storedCommandCandidates } from "../src/main/database/component-invocation-stored-candidates.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { makeSession } from "./normalized-session-test-utils.js";

const NOW = "2026-07-22T17:00:00.000Z";
const TS = "2026-07-22T17:00:01.000Z";

function commandKeys(
  sessionId: string,
  overrides: Partial<NormalizedSession>
): string[] {
  return deriveAgentComponentInvocationCandidates(
    makeSession({ sessionId, ...overrides }),
    "main-agent",
    NOW
  )
    .filter(
      (candidate) =>
        candidate.componentKind === AgentComponentInvocationKind.Command
    )
    .map((candidate) => candidate.componentKey);
}

/**
 * ISS-4795 — a command has ONE component key at the invocation boundary.
 *
 * The definition-file collector hand-prepended `/` to a frontmatter `name` that
 * already carried one, so it minted `//build` while this path minted `/build`.
 * Org-dedup then rendered the same command as two components splitting one
 * usage population. Both producers now route through the shared normalizer;
 * this pins the invocation half of that contract.
 */
describe("ISS-4795 command component-key identity", () => {
  test("a doubled leading slash collapses onto the single-slash key", () => {
    assert.deepEqual(
      commandKeys("doubled", {
        slashCommands: [{ name: "//clear", timestamp: TS }],
      }),
      ["/clear"]
    );
  });

  test("both spellings of one command produce the same key", () => {
    const [doubled] = commandKeys("a", {
      slashCommands: [{ name: "//code-review:deep", timestamp: TS }],
    });
    const [single] = commandKeys("b", {
      slashCommands: [{ name: "/code-review:deep", timestamp: TS }],
    });
    const [bare] = commandKeys("c", {
      slashCommands: [{ name: "code-review:deep", timestamp: TS }],
    });

    assert.equal(doubled, "/code-review:deep");
    assert.equal(single, doubled);
    assert.equal(bare, doubled);
  });
});

/**
 * ISS-4796 — a truncated command-palette display string is not a command.
 *
 * `/...` and `/…` were captured verbatim as slash-command names and admitted as
 * real inventory components. They sorted to the very top of the Commands tab
 * (leading punctuation), inflated its count, and resolved to detail pages
 * reading "No definition captured". A record is valid-or-absent, so they are
 * rejected here rather than filtered at render.
 */
describe("ISS-4796 placeholder command admission", () => {
  for (const placeholder of ["/...", "/…", "/", "/.."]) {
    test(`rejects the placeholder ${JSON.stringify(placeholder)}`, () => {
      assert.deepEqual(
        commandKeys(`placeholder-${placeholder}`, {
          slashCommands: [{ name: placeholder, timestamp: TS }],
        }),
        []
      );
    });
  }

  test("keeps real commands invoked alongside a placeholder", () => {
    assert.deepEqual(
      commandKeys("mixed", {
        slashCommands: [
          { name: "/...", timestamp: TS },
          { name: "/compact", timestamp: TS },
          { name: "/…", timestamp: TS },
        ],
      }),
      ["/compact"]
    );
  });
});

/**
 * ISS-4796 — the STORED-ROW REBUILD half of the same admission contract.
 *
 * wongk (PR #4322): "The new test never runs the stored-row rebuild, so dropping
 * this gate later can re-admit `/...` from persisted session metadata while the
 * live path stays green."
 *
 * `storedCommandCandidates` is the bridge for sessions that cannot be reparsed
 * (transcript gone, or parser output rejected): it rebuilds command invocations
 * straight out of persisted `slashCommands` metadata, which is exactly where the
 * placeholders already sit on existing installs. Every test above drives
 * `deriveAgentComponentInvocationCandidates` — the LIVE path — so the stored
 * bridge's own `isAdmissibleCommandComponentKey` gate had no coverage at all and
 * could be deleted without turning anything red.
 */
describe("ISS-4796 stored-row rebuild admission", () => {
  /**
   * The rebuild's only query is the inventory `resolved_state` lookup; an empty
   * result is the honest shape for a session with no resolved command rows, and
   * keeps this focused on admission rather than on skill-shadow suppression.
   */
  function emptyInventoryTx() {
    return {
      $queryRawUnsafe<T>(): Promise<T> {
        return Promise.resolve([] as T);
      },
    };
  }

  function storedCommandKeys(
    slashCommands: Array<{ name: string; timestamp: string }>
  ): Promise<string[]> {
    return storedCommandCandidates({
      tx: emptyInventoryTx(),
      sessionId: "stored-session",
      metadata: JSON.stringify({ slashCommands }),
      gitBranch: null,
      repositoryFullName: null,
      now: NOW,
      skillOccurrences: [],
      priorResolvedCommandKeys: new Set<string>(),
    }).then((candidates) =>
      candidates.map((candidate) => candidate.componentKey)
    );
  }

  test("rejects placeholders rebuilt from persisted session metadata", async () => {
    assert.deepEqual(
      await storedCommandKeys([
        { name: "/...", timestamp: TS },
        { name: "/…", timestamp: TS },
      ]),
      []
    );
  });

  test("keeps a real command and collapses its doubled slash on rebuild", async () => {
    assert.deepEqual(
      await storedCommandKeys([
        { name: "/...", timestamp: TS },
        { name: "//compact", timestamp: TS },
      ]),
      ["/compact"]
    );
  });
});
