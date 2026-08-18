import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";

type WriteOracleProposalInput = {
  outputRoot: string;
  corpusRoot: string;
  sessionId: string;
  contents: string;
};

export function assertProposalOutputRoot(
  outputRoot: string,
  corpusRoot: string
): void {
  const resolvedOutputRoot = resolveThroughExistingAncestor(outputRoot);
  const resolvedCorpusRoot = realpathSync(corpusRoot);
  if (isWithinPath(resolvedCorpusRoot, resolvedOutputRoot)) {
    throw new Error(
      "refusing to write proposals inside packages/golden-sessions — the corpus is frozen (see packages/golden-sessions/AGENTS.md)"
    );
  }
}

export function writeOracleProposal({
  outputRoot,
  corpusRoot,
  sessionId,
  contents,
}: WriteOracleProposalInput): void {
  assertProposalOutputRoot(outputRoot, corpusRoot);
  const resolvedOutputRoot = resolve(outputRoot);
  const sessionOutputDir = resolve(resolvedOutputRoot, sessionId);
  if (!isWithinPath(resolvedOutputRoot, sessionOutputDir)) {
    throw new Error(`invalid proposal session id: ${sessionId}`);
  }

  mkdirSync(sessionOutputDir, { recursive: true });
  assertProposalOutputRoot(sessionOutputDir, corpusRoot);
  writeFileSync(resolve(sessionOutputDir, "normalized.json"), contents, {
    flag: "wx",
  });
}

function resolveThroughExistingAncestor(path: string): string {
  let existingAncestor = resolve(path);
  const missingSegments: string[] = [];
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) {
      break;
    }
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

function isWithinPath(parent: string, candidate: string): boolean {
  const relativePath = relative(parent, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}
