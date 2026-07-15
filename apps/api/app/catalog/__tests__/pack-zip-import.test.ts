import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { buildZipWithEntries } from "../../../__tests__/fixtures/zip-helpers";
import {
  PackZipTooLargeError,
  parsePackZip,
  ZIP_MAX_DECOMPRESSED_BYTES,
  ZIP_MAX_ENTRIES,
} from "../pack-zip-import";

/**
 * Build a "zip bomb" buffer: each entry stores tiny data but its
 * central-directory record declares a large uncompressed `size`. This models a
 * real bomb (small on disk, huge inflated) without allocating the inflated
 * bytes, so the decompressed-budget guard — which reads the declared size
 * BEFORE inflating — can be exercised cheaply.
 */
function buildBombZip(
  entries: Array<{ name: string; declaredSize: number }>
): Buffer {
  const zip = new AdmZip();
  for (const entry of entries) {
    zip.addFile(entry.name, Buffer.from("x"));
  }
  for (const zipEntry of zip.getEntries()) {
    const target = entries.find((e) => e.name === zipEntry.entryName);
    if (target) {
      // adm-zip's entryHeader exposes a settable `size` that toBuffer() writes
      // into the central-directory CENLEN field.
      zipEntry.header.size = target.declaredSize;
    }
  }
  return zip.toBuffer();
}

describe("parsePackZip", () => {
  it("classifies the canonical Claude Code layout", () => {
    const zip = buildZipWithEntries([
      {
        name: "agents/reviewer.md",
        content: "---\nname: reviewer\n---\nReview.",
      },
      { name: "commands/deploy.md", content: "Deploy it." },
      { name: "skills/plan/SKILL.md", content: "# Plan" },
      { name: "README.md", content: "ignored" },
    ]);
    const parsed = parsePackZip(zip);
    expect(parsed).toContainEqual({
      kind: "agent",
      name: "reviewer",
      content: "---\nname: reviewer\n---\nReview.",
    });
    expect(parsed.find((c) => c.kind === "command")?.name).toBe("deploy");
    expect(parsed.find((c) => c.kind === "skill")?.name).toBe("plan");
    // Top-level README is not a recognized component.
    expect(parsed).toHaveLength(3);
  });

  it("handles a leading root folder and a .claude/ prefix", () => {
    const zip = buildZipWithEntries([
      { name: "shared_repo/agents/a.md", content: "a" },
      { name: "shared_repo/.claude/commands/c.md", content: "c" },
    ]);
    const parsed = parsePackZip(zip);
    expect(parsed.find((c) => c.kind === "agent")?.name).toBe("a");
    expect(parsed.find((c) => c.kind === "command")?.name).toBe("c");
  });

  it("expands .mcp.json into one component per server", () => {
    const zip = buildZipWithEntries([
      {
        name: ".mcp.json",
        content: JSON.stringify({
          mcpServers: {
            posthog: { command: "npx", args: ["-y", "@posthog/mcp"] },
            linear: { url: "https://mcp.linear.app" },
          },
        }),
      },
    ]);
    const parsed = parsePackZip(zip);
    expect(parsed.filter((c) => c.kind === "mcp")).toHaveLength(2);
    const posthog = parsed.find((c) => c.name === "posthog");
    expect(posthog?.content).toContain('"command": "npx"');
  });

  it("dedupes components by kind + name", () => {
    const zip = buildZipWithEntries([
      { name: "agents/dup.md", content: "first" },
      { name: "nested/agents/dup.md", content: "second" },
    ]);
    const parsed = parsePackZip(zip);
    expect(parsed.filter((c) => c.kind === "agent")).toHaveLength(1);
  });

  it("still imports a normal-sized pack (budget not tripped)", () => {
    const zip = buildZipWithEntries([
      { name: "agents/reviewer.md", content: "---\nname: reviewer\n---\nR" },
      { name: "commands/deploy.md", content: "Deploy it." },
    ]);
    const parsed = parsePackZip(zip);
    expect(parsed).toHaveLength(2);
  });

  it("rejects a zip bomb whose decompressed size exceeds the budget", () => {
    // A single entry whose central-directory declares a huge uncompressed size
    // while the stored data is tiny — the essence of a zip bomb. The guard must
    // reject on the DECLARED size BEFORE inflating, so the test forges the
    // header rather than allocating GBs (which the guard exists to prevent).
    const buffer = buildBombZip([
      { name: "agents/bomb.md", declaredSize: ZIP_MAX_DECOMPRESSED_BYTES + 1 },
    ]);

    expect(() => parsePackZip(buffer)).toThrow(PackZipTooLargeError);
  });

  it("rejects a zip whose summed entry sizes exceed the budget", () => {
    // No single entry is over budget, but their sum is — exercises the running
    // total, not just the per-entry check.
    const halfPlus = Math.ceil(ZIP_MAX_DECOMPRESSED_BYTES / 2) + 1;
    const buffer = buildBombZip([
      { name: "agents/a.md", declaredSize: halfPlus },
      { name: "agents/b.md", declaredSize: halfPlus },
    ]);

    expect(() => parsePackZip(buffer)).toThrow(PackZipTooLargeError);
  });

  it("rejects a zip with more than the entry-count cap", () => {
    const entries = Array.from({ length: ZIP_MAX_ENTRIES + 1 }, (_, i) => ({
      name: `misc/file-${i}.txt`,
      content: "x",
    }));
    const buffer = buildZipWithEntries(entries);

    expect(() => parsePackZip(buffer)).toThrow(PackZipTooLargeError);
  });
});
