import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  assertProposalOutputRoot,
  writeOracleProposal,
} from "./golden/fea3419-oracle-output.js";

const PROPOSAL_PATH_ERROR = /refusing to write proposals/;
const EXISTING_FILE_ERROR = /EEXIST/;

test("FEA-3419 proposal output rejects symlinks into the frozen corpus", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fea3419-output-"));
  try {
    const corpusRoot = path.join(root, "packages", "golden-sessions");
    const outputLink = path.join(root, "proposal-link");
    await mkdir(corpusRoot, { recursive: true });
    await symlink(corpusRoot, outputLink, "dir");

    assert.throws(
      () => assertProposalOutputRoot(outputLink, corpusRoot),
      PROPOSAL_PATH_ERROR
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("FEA-3419 proposal output never overwrites an existing proposal", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fea3419-output-"));
  try {
    const corpusRoot = path.join(root, "packages", "golden-sessions");
    const outputRoot = path.join(root, "proposals");
    const sessionDir = path.join(outputRoot, "session-1");
    const outputFile = path.join(sessionDir, "normalized.json");
    await mkdir(corpusRoot, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await writeFile(outputFile, "human-reviewed\n");

    assert.throws(
      () =>
        writeOracleProposal({
          outputRoot,
          corpusRoot,
          sessionId: "session-1",
          contents: "replacement\n",
        }),
      EXISTING_FILE_ERROR
    );
    assert.equal(await readFile(outputFile, "utf8"), "human-reviewed\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
