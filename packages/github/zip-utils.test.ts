import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { extractInnerZips, SYMPHONY_RUN_ARTIFACT_PREFIXES } from "./zip-utils";

function toBuffer(content: string): Buffer {
  return Buffer.from(content, "utf-8");
}

describe("extractInnerZips", () => {
  it("extracts nested .zip files from outer zip", () => {
    const innerZip = new AdmZip();
    innerZip.addFile("hello.txt", toBuffer("hello"));

    const outerZip = new AdmZip();
    outerZip.addFile("symphony-run.zip", innerZip.toBuffer());

    const result = extractInnerZips(outerZip);
    expect(result).toHaveLength(1);

    const entries = result[0]!.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entryName).toBe("hello.txt");
  });

  it("returns empty array when no nested zips exist", () => {
    const zip = new AdmZip();
    zip.addFile("file.txt", toBuffer("content"));

    const result = extractInnerZips(zip);
    expect(result).toHaveLength(0);
  });

  it("skips directories ending in .zip", () => {
    const zip = new AdmZip();
    zip.addFile("fake.zip/", Buffer.alloc(0));
    zip.addFile("file.txt", toBuffer("content"));

    const result = extractInnerZips(zip);
    expect(result).toHaveLength(0);
  });

  it("handles multiple nested zips", () => {
    const inner1 = new AdmZip();
    inner1.addFile("a.txt", toBuffer("a"));

    const inner2 = new AdmZip();
    inner2.addFile("b.txt", toBuffer("b"));

    const outerZip = new AdmZip();
    outerZip.addFile("first.zip", inner1.toBuffer());
    outerZip.addFile("second.zip", inner2.toBuffer());

    const result = extractInnerZips(outerZip);
    expect(result).toHaveLength(2);
  });

  it("skips corrupt nested zips without crashing", () => {
    const outerZip = new AdmZip();
    outerZip.addFile("corrupt.zip", toBuffer("not a real zip"));
    outerZip.addFile("file.txt", toBuffer("content"));

    const result = extractInnerZips(outerZip);
    expect(result).toHaveLength(0);
  });
});

describe("SYMPHONY_RUN_ARTIFACT_PREFIXES", () => {
  it("matches expected artifact names", () => {
    const names = ["symphony-run-123", "symphony-dispatch-456"];
    for (const name of names) {
      const matches = SYMPHONY_RUN_ARTIFACT_PREFIXES.some((p) =>
        name.startsWith(p)
      );
      expect(matches).toBe(true);
    }
  });

  it("does not match unrelated artifact names", () => {
    const names = ["run-loop-log-123", "execution-logs", "other-artifact"];
    for (const name of names) {
      const matches = SYMPHONY_RUN_ARTIFACT_PREFIXES.some((p) =>
        name.startsWith(p)
      );
      expect(matches).toBe(false);
    }
  });
});
