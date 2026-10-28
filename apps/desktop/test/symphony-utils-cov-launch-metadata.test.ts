/**
 * ISS-10307 — branch coverage for `src/server/operations/symphony-utils.ts`:
 * `parseLaunchMetadataContent`'s per-field type guards, reached only through
 * the exported `readLaunchMetadata`. Launch metadata written by builds before
 * ISS-12435 can still carry `loopId`; the reader drops it.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "vitest";
import { readLaunchMetadata } from "../src/server/operations/symphony-utils.js";
import { createGitOpTempDirs } from "./helpers/git-gateway-op-harness.js";

const { makeTempDir } = createGitOpTempDirs("iss10307-symutils-metadata-");

function launchMetadataPath(dir: string): string {
  return path.join(dir, ".closedloop-ai", "work", "launch-metadata.json");
}

describe("readLaunchMetadata — parseLaunchMetadataContent per-field type guards", () => {
  test("a non-string artifactId falls back to undefined and a legacy loopId is dropped", () => {
    const dir = makeTempDir();
    mkdirSync(path.dirname(launchMetadataPath(dir)), { recursive: true });
    writeFileSync(
      launchMetadataPath(dir),
      JSON.stringify({ artifactId: 42, loopId: { nested: true } })
    );

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      artifactId: undefined,
      baseBranch: undefined,
      issueId: undefined,
      parentTicketId: undefined,
      ticketTitle: undefined,
    });
  });

  test("every string-typed field is passed through verbatim", () => {
    const dir = makeTempDir();
    mkdirSync(path.dirname(launchMetadataPath(dir)), { recursive: true });
    writeFileSync(
      launchMetadataPath(dir),
      JSON.stringify({
        issueId: "ISS-1",
        ticketTitle: "Fix the thing",
        artifactId: "FEA-2015",
        baseBranch: "develop",
        parentTicketId: "AI-100",
      })
    );

    const meta = readLaunchMetadata(dir);
    assert.deepEqual(meta, {
      issueId: "ISS-1",
      ticketTitle: "Fix the thing",
      artifactId: "FEA-2015",
      baseBranch: "develop",
      parentTicketId: "AI-100",
    });
  });
});
