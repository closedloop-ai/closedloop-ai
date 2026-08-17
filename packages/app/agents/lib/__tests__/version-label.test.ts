import type { ComponentVersion } from "@repo/api/src/types/agent-component";
import { describe, expect, it } from "vitest";
import {
  coerceHash,
  versionLabelByBranch,
  versionLabelBySession,
  versionLabelForHash,
} from "../version-label";

const versions: ComponentVersion[] = [
  {
    hash: "hashcurrent000",
    source: "",
    format: "md",
    createdAt: "2026-06-01T00:00:00.000Z",
    isCurrent: true,
    content: "current",
  },
  {
    hash: "hasholder1111",
    source: "",
    format: "md",
    createdAt: "2026-05-01T00:00:00.000Z",
    isCurrent: false,
    content: "older",
  },
];

describe("versionLabelForHash", () => {
  it("labels the current revision 'Current' and older ones 'Rev N'", () => {
    expect(versionLabelForHash("hashcurrent000", versions)).toBe("Current");
    // Two revisions total, older one is index 1 → Rev (2 - 1) = Rev 1.
    expect(versionLabelForHash("hasholder1111", versions)).toBe("Rev 1");
  });

  it("falls back to a short #prefix for an unknown hash", () => {
    expect(versionLabelForHash("deadbeefcafef00d", versions)).toBe("#deadbee");
  });

  it("returns null for a missing hash (unattributed usage)", () => {
    expect(versionLabelForHash(null, versions)).toBeNull();
    expect(versionLabelForHash(undefined, versions)).toBeNull();
  });

  // FEA-3520 regression: the DTO types `hash` as `string`, but a malformed /
  // differently-shaped record (the stage Skill-component crash) can deliver a
  // non-string. Calling `.slice` on it threw inside the detail page's
  // LiveblocksErrorBoundary → crash-spiral. Every shape must resolve without
  // throwing (same class as the #3208 `sessionStartedAt` fix).
  it("never throws on a non-string hash and coerces numbers to a #prefix", () => {
    // A numeric hash is coerced to its string form → usable #prefix.
    expect(() =>
      versionLabelForHash(12_345_678 as unknown as string, versions)
    ).not.toThrow();
    expect(versionLabelForHash(12_345_678 as unknown as string, versions)).toBe(
      "#1234567"
    );

    // Object / array / boolean-false collapse to "no hash" → null, never a throw.
    for (const bad of [
      {} as unknown as string,
      [] as unknown as string,
      false as unknown as string,
      Number.NaN as unknown as string,
    ]) {
      expect(() => versionLabelForHash(bad, versions)).not.toThrow();
    }
  });

  it("does not throw when a version in the list carries a non-string hash", () => {
    const malformedVersions = [
      { ...versions[0], hash: 999 as unknown as string },
      versions[1],
    ];
    expect(() =>
      versionLabelForHash("hasholder1111", malformedVersions)
    ).not.toThrow();
    expect(versionLabelForHash("hasholder1111", malformedVersions)).toBe(
      "Rev 1"
    );
  });
});

describe("coerceHash", () => {
  it("passes strings through and coerces primitives, collapsing others to ''", () => {
    expect(coerceHash("abc123")).toBe("abc123");
    expect(coerceHash(42)).toBe("42");
    expect(coerceHash(true)).toBe("true");
    expect(coerceHash(10n)).toBe("10");
    expect(coerceHash(null)).toBe("");
    expect(coerceHash(undefined)).toBe("");
    expect(coerceHash({})).toBe("");
    expect(coerceHash([])).toBe("");
  });
});

describe("versionLabelBySession", () => {
  it("maps only sessions with an attributed hash", () => {
    const map = versionLabelBySession(
      [
        { sessionId: "s1", versionHash: "hashcurrent000" },
        { sessionId: "s2", versionHash: null },
        { sessionId: "s3", versionHash: "hasholder1111" },
      ],
      versions
    );
    expect(map.get("s1")).toBe("Current");
    expect(map.has("s2")).toBe(false);
    expect(map.get("s3")).toBe("Rev 1");
  });
});

describe("versionLabelByBranch", () => {
  it("maps by branch name, keeping the first attribution per branch", () => {
    const map = versionLabelByBranch(
      [
        { branchName: "feat/a", versionHash: "hashcurrent000" },
        { branchName: "feat/a", versionHash: "hasholder1111" },
        { branchName: null, versionHash: "hashcurrent000" },
      ],
      versions
    );
    expect(map.get("feat/a")).toBe("Current");
    expect(map.size).toBe(1);
  });
});
