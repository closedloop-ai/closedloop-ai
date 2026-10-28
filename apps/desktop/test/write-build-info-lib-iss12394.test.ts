/**
 * ISS-12394 — `write-build-info-lib.mjs` on the inputs the existing suite does
 * not drive in-process: a package.json without a usable version, and the write
 * branch for an absent or stale output file.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BuildInfoWriteOutcome,
  renderBuildInfoSource,
  resolveAppVersion,
  writeBuildInfoIfChanged,
} from "../scripts/write-build-info-lib.mjs";

const DISPLAY_PATH = "src/shared/build-info.ts";

describe("resolveAppVersion", () => {
  it.each([
    ["null", null],
    ["a string", "1.2.3"],
    ["an object with no version", { name: "desktop" }],
    ["a numeric version", { version: 3 }],
    ["undefined", undefined],
  ])("returns an empty string for %s", (_label, input) => {
    expect(resolveAppVersion(input)).toBe("");
  });

  it("returns a string version as-is", () => {
    expect(resolveAppVersion({ version: "0.9.1" })).toBe("0.9.1");
  });
});

describe("writeBuildInfoIfChanged", () => {
  let dir = "";
  let outFile = "";
  const contents = renderBuildInfoSource({
    commitHash: "abc123",
    appVersion: "1.0.0",
  });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "build-info-iss12394-"));
    outFile = path.join(dir, "build-info.ts");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes the file when it does not exist", () => {
    const result = writeBuildInfoIfChanged({
      outFile,
      contents,
      displayPath: DISPLAY_PATH,
    });
    expect(result).toEqual({
      outcome: BuildInfoWriteOutcome.Wrote,
      message: `write-build-info: wrote ${DISPLAY_PATH}\n`,
    });
    expect(readFileSync(outFile, "utf8")).toBe(contents);
  });

  it("overwrites the file when its contents differ", () => {
    writeFileSync(outFile, "stale", "utf8");
    const result = writeBuildInfoIfChanged({
      outFile,
      contents,
      displayPath: DISPLAY_PATH,
    });
    expect(result.outcome).toBe(BuildInfoWriteOutcome.Wrote);
    expect(readFileSync(outFile, "utf8")).toBe(contents);
  });

  it("reports unchanged and leaves the file alone when contents match", () => {
    writeFileSync(outFile, contents, "utf8");
    const result = writeBuildInfoIfChanged({
      outFile,
      contents,
      displayPath: DISPLAY_PATH,
    });
    expect(result).toEqual({
      outcome: BuildInfoWriteOutcome.Unchanged,
      message: "write-build-info: unchanged\n",
    });
  });
});
