import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  computePartitionSourceHashes,
  computePartitionStats,
  computeTestTreeHash,
  DenominatorKind,
  derivePct,
  mergeLaneMaps,
  PARTITION_RULES,
  partitionOf,
  partitionRulesHash,
  renderMarkdown,
  stableContentHash,
} from "../scripts/report-coverage-lib.mjs";

// Minimal istanbul file-coverage entry: one branch (2 outcomes), `taken` of
// them hit. Absolute paths mimic real c8/vitest output.
function istanbulFile(taken: number) {
  return {
    b: { "0": [taken > 0 ? 1 : 0, taken > 1 ? 1 : 0] },
    branchMap: {
      "0": {
        type: "if",
        locations: [
          { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
        ],
      },
    },
  };
}

const DESKTOP = "/repo/apps/desktop";
const HASH_TOKEN_PATTERN = /^h[0-9a-f]+$/;
const LEDGER_ID_PATTERN = /sample-entry/;
const LEDGER_REASON_PATTERN = /named, not omitted/;
const canonicalPath = (raw: string) =>
  raw.startsWith(`${DESKTOP}/`) ? raw.slice(DESKTOP.length + 1) : null;

function statsFor(files: Map<string, unknown>, universe: string[]) {
  return computePartitionStats(
    files as Parameters<typeof computePartitionStats>[0],
    universe
  );
}
describe("partitionOf", () => {
  test("collectors wins over main for its subtree", () => {
    assert.equal(
      partitionOf("src/main/collectors/claude/parse.ts"),
      "collectors"
    );
    assert.equal(partitionOf("src/main/cloud/api.ts"), "main");
  });

  test("maps every partition root and rejects foreign paths", () => {
    assert.equal(partitionOf("src/server/router.ts"), "gateway");
    assert.equal(partitionOf("src/renderer/components/app.tsx"), "renderer");
    assert.equal(partitionOf("src/shared/ipc-channels.ts"), "shared");
    assert.equal(partitionOf("scripts/run-node-tests.mjs"), "tooling");
    assert.equal(partitionOf("src/mainframe/decoy.ts"), null);
    assert.equal(partitionOf("package.json"), null);
  });
});
describe("mergeLaneMaps", () => {
  test("renderer files come only from the renderer lane and others only from node", () => {
    const rendererFile = `${DESKTOP}/src/renderer/components/app.tsx`;
    const mainFile = `${DESKTOP}/src/main/cloud/api.ts`;
    const { files } = mergeLaneMaps({
      // node lane also saw the renderer file — with full hits, which must be
      // ignored in favor of the renderer lane's zero-hit measurement.
      nodeMap: { [mainFile]: istanbulFile(2), [rendererFile]: istanbulFile(2) },
      rendererMap: { [rendererFile]: istanbulFile(0) },
      canonicalPath,
    });
    assert.equal(files.size, 2);
    const stats = statsFor(files, []);
    assert.equal(stats.renderer.branchesCovered, 0);
    assert.equal(stats.renderer.branchesTotal, 2);
    assert.equal(stats.main.branchesCovered, 2);
  });

  test("rejects a summary map even in a single-lane call", () => {
    const mainFile = `${DESKTOP}/src/main/cloud/api.ts`;
    const summaryMap = {
      total: { branches: { total: 10, covered: 5 } },
      [mainFile]: { branches: { total: 10, covered: 5 } },
    };
    const nodeOnly = mergeLaneMaps({
      nodeMap: summaryMap,
      rendererMap: null,
      canonicalPath,
    });
    assert.equal(nodeOnly.rejections.length, 1);
    assert.equal(nodeOnly.files.size, 0);
  });
});
describe("computePartitionStats", () => {
  test("counts raw branches, executed files, and source universe per partition", () => {
    const { files } = mergeLaneMaps({
      nodeMap: {
        [`${DESKTOP}/src/server/router.ts`]: istanbulFile(1),
        [`${DESKTOP}/src/main/collectors/claude/parse.ts`]: istanbulFile(2),
      },
      rendererMap: null,
      canonicalPath,
    });
    const stats = statsFor(files, [
      "src/server/router.ts",
      "src/server/security.ts",
      "src/main/collectors/claude/parse.ts",
    ]);
    assert.deepEqual(stats.gateway, {
      branchesCovered: 1,
      branchesTotal: 2,
      branchPct: 50,
      executedFiles: 1,
      sourceFiles: 2,
    });
    assert.equal(stats.collectors.branchPct, 100);
    assert.equal(stats.renderer.branchesTotal, 0);
    assert.equal(stats.renderer.branchPct, 0);
  });
});
describe("derivePct", () => {
  test("zero total is 0%, not NaN", () => {
    assert.equal(derivePct(0, 0), 0);
    assert.equal(derivePct(1, 3), 33.33);
  });
});
describe("partitionRulesHash", () => {
  test("changes when the partition rules change", () => {
    const current = partitionRulesHash(PARTITION_RULES);
    const mutated = partitionRulesHash([
      ...PARTITION_RULES,
      {
        name: "extra",
        prefix: "src/extra/",
        denominator: DenominatorKind.Execution,
      },
    ]);
    assert.notEqual(current, mutated);
  });

  // The declared denominator is part of what the numbers MEAN: flipping a
  // partition between execution- and source-derived changes whether a moving
  // branch total can earn a churn allowance, so it must force a comparison
  // refusal rather than silently re-judge old numbers under new rules.
  test("changes when a partition's denominator provenance changes", () => {
    const flipped = PARTITION_RULES.map((rule) =>
      rule.name === "renderer"
        ? { ...rule, denominator: DenominatorKind.Execution }
        : rule
    );
    assert.notEqual(
      partitionRulesHash(PARTITION_RULES),
      partitionRulesHash(flipped)
    );
  });
});
describe("renderMarkdown", () => {
  test("renders every partition row and every ledger entry", () => {
    const stats = statsFor(new Map(), []);
    const markdown = renderMarkdown(stats, {
      generatedAt: "2026-08-05T00:00:00.000Z",
      validityLedger: [{ id: "sample-entry", reason: "named, not omitted" }],
    });
    for (const rule of PARTITION_RULES) {
      assert.match(markdown, new RegExp(`\\| ${rule.name} \\|`));
    }
    assert.match(markdown, LEDGER_ID_PATTERN);
    assert.match(markdown, LEDGER_REASON_PATTERN);
  });
});
describe("computePartitionSourceHashes", () => {
  const universe = ["src/server/router.ts", "src/renderer/app.tsx"];
  const read = (contents: Record<string, string>) => (path: string) =>
    contents[path] ?? "";

  // MULTIPLE files inside ONE partition, which is what makes this test able to
  // fail: with a single file per partition the concatenation order is fixed no
  // matter what, so dropping the sort() left the old version of this test green
  // under the exact mutation it names.
  test("the same tree fingerprints the same, whatever order it is walked", () => {
    const contents = {
      "src/server/router.ts": "export const a = 1;",
      "src/server/auth.ts": "export const c = 3;",
      "src/server/session.ts": "export const d = 4;",
      "src/renderer/app.tsx": "export const b = 2;",
      "src/renderer/panel.tsx": "export const e = 5;",
    };
    const walked = Object.keys(contents);
    const first = computePartitionSourceHashes(walked, read(contents));
    const second = computePartitionSourceHashes(
      [...walked].reverse(),
      read(contents)
    );
    assert.equal(first.gateway, second.gateway);
    assert.equal(first.renderer, second.renderer);
  });

  // What these inputs pin, and all they pin: distinct (path, content) sets
  // fingerprint distinctly. They do NOT isolate the NUL joiner — deleting it
  // leaves this green, because the boundary is unambiguous for a second reason
  // that the next test owns.
  test("distinct (path, content) sets fingerprint distinctly", () => {
    const left = computePartitionSourceHashes(["src/server/ab.ts"], () => "c");
    const right = computePartitionSourceHashes(["src/server/a.ts"], () => "bc");
    assert.notEqual(left.gateway, right.gateway);

    // Two files whose concatenation is ambiguous without a delimiter.
    const split = computePartitionSourceHashes(
      ["src/server/a.ts", "src/server/ab.ts"],
      (path) => (path === "src/server/a.ts" ? "b" : "")
    );
    const other = computePartitionSourceHashes(
      ["src/server/a.ts", "src/server/ab.ts"],
      (path) => (path === "src/server/a.ts" ? "" : "b")
    );
    assert.notEqual(split.gateway, other.gateway);
  });

  // WHY that boundary cannot be forged by shifting the split, and the property
  // the joiner alone does not supply. Forging needs one entry's content hash to
  // end with a whole other content hash, so the token must contain a second `h`
  // — and `h` + lowercase hex cannot, at any length. Widen the radix (base 36
  // reaches `h`) and that stops being true, at which point the NUL in
  // `fingerprintFiles` is the only thing between two different trees and one
  // fingerprint. The corpus is fixed and the hash deterministic: base 16 emits
  // zero violations over it, base 36 emits 200.
  test("a content hash is a token no other content hash can start inside", () => {
    for (let length = 1; length <= 200; length += 1) {
      const token = stableContentHash("a".repeat(length));
      assert.match(
        token,
        HASH_TOKEN_PATTERN,
        `${token} is outside the h+hex alphabet the boundary argument rests on`
      );
      assert.equal(
        token.lastIndexOf("h"),
        0,
        `${token} carries a second boundary marker, so a hash can end inside another`
      );
    }
  });

  test("an edit, an addition, and a deletion each move only their partition", () => {
    const base = computePartitionSourceHashes(
      universe,
      read({
        "src/server/router.ts": "export const a = 1;",
        "src/renderer/app.tsx": "export const b = 2;",
      })
    );
    const edited = computePartitionSourceHashes(
      universe,
      read({
        "src/server/router.ts": "export const a = 2;",
        "src/renderer/app.tsx": "export const b = 2;",
      })
    );
    assert.notEqual(base.gateway, edited.gateway);
    assert.equal(base.renderer, edited.renderer);

    const added = computePartitionSourceHashes(
      [...universe, "src/server/auth.ts"],
      read({
        "src/server/router.ts": "export const a = 1;",
        "src/renderer/app.tsx": "export const b = 2;",
        "src/server/auth.ts": "export const c = 3;",
      })
    );
    assert.notEqual(base.gateway, added.gateway);

    // Deleted FROM a partition that still has files, so the assertion is a
    // comparison of two real fingerprints. Emptying the partition entirely
    // would withhold the hash and pass this line against `undefined` without
    // ever exercising the deletion.
    const deleted = computePartitionSourceHashes(
      ["src/server/auth.ts", "src/renderer/app.tsx"],
      read({
        "src/server/auth.ts": "export const c = 3;",
        "src/renderer/app.tsx": "export const b = 2;",
      })
    );
    assert.equal(typeof deleted.gateway, "string");
    assert.notEqual(added.gateway, deleted.gateway);
  });

  // Unproven must read as changed: `fingerprintsAgree` refuses an absent hash,
  // so withholding is what withholds the churn allowance.
  test("an unreadable file withholds its whole partition's fingerprint", () => {
    const readable = computePartitionSourceHashes(
      ["src/server/router.ts", "src/server/auth.ts"],
      () => "export const a = 1;"
    );
    assert.equal(typeof readable.gateway, "string");

    const oneUnreadable = computePartitionSourceHashes(
      ["src/server/router.ts", "src/server/auth.ts"],
      (path) => (path === "src/server/auth.ts" ? null : "export const a = 1;")
    );
    assert.equal(oneUnreadable.gateway, undefined);
  });

  test("a partition with no files gets no fingerprint", () => {
    const hashes = computePartitionSourceHashes(
      ["src/server/router.ts"],
      () => "export const a = 1;"
    );
    assert.equal(typeof hashes.gateway, "string");
    assert.equal(hashes.renderer, undefined);
  });
});
describe("computeTestTreeHash", () => {
  const read = (contents: Record<string, string>) => (path: string) =>
    contents[path] ?? "";

  test("a weakened test moves the fingerprint", () => {
    const before = computeTestTreeHash(
      ["test/gateway.test.ts"],
      read({
        "test/gateway.test.ts": "assert.equal(routeFor('/a'), 'a');",
      })
    );
    const weakened = computeTestTreeHash(
      ["test/gateway.test.ts"],
      read({
        "test/gateway.test.ts": "assert.ok(true);",
      })
    );
    assert.notEqual(before, weakened);
  });

  test("a deleted test moves the fingerprint", () => {
    const both = computeTestTreeHash(
      ["test/a.test.ts", "test/b.test.ts"],
      read({ "test/a.test.ts": "x", "test/b.test.ts": "y" })
    );
    const one = computeTestTreeHash(
      ["test/a.test.ts"],
      read({ "test/a.test.ts": "x" })
    );
    assert.notEqual(both, one);
  });

  test("an unchanged test tree fingerprints the same in any walk order", () => {
    const contents = {
      "test/a.test.ts": "x",
      "test/b.test.ts": "y",
      "src/renderer/__tests__/c.test.tsx": "z",
    };
    const walked = Object.keys(contents);
    assert.equal(
      computeTestTreeHash(walked, read(contents)),
      computeTestTreeHash([...walked].reverse(), read(contents))
    );
  });

  test("an unreadable test file withholds the fingerprint", () => {
    assert.equal(
      computeTestTreeHash(["test/a.test.ts", "test/b.test.ts"], (path) =>
        path === "test/b.test.ts" ? null : "x"
      ),
      undefined
    );
  });

  test("an empty test tree withholds the fingerprint", () => {
    // Hashing nothing is a constant, and a constant agrees with itself — so
    // "there were no tests" would otherwise be granted the full allowance.
    assert.equal(
      computeTestTreeHash([], () => "x"),
      undefined
    );
  });
});
