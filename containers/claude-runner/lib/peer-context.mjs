import fs from "node:fs";
import path from "node:path";
import { AdditionalRepoRefSchema } from "@closedloop-ai/loops-api/context-pack";

/**
 * Canonical peers parent directory inside the ECS workspace. Exported so
 * other harness code (e.g. `cloneAdditionalRepos`) can share a single source
 * of truth for the path.
 */
export const DEFAULT_PEERS_DIR = "/workspace/peers";

/**
 * Build local-path metadata for each peer repo. The slug-fullName ("owner--repo")
 * convention matches `cloneAdditionalRepos` so the path returned here is the same
 * absolute path the runtime cloned into.
 *
 * Validates each entry against the canonical `AdditionalRepoRefSchema` from
 * `@closedloop-ai/loops-api/context-pack` (the same schema applied upstream
 * to the context pack at download time). Invalid entries are logged and
 * skipped rather than silently included with a malformed path — this keeps
 * `peer-repos.json`, the prompt footer, and `cloneAdditionalRepos` in lockstep
 * so the agent is never told about a peer that wasn't actually mounted.
 *
 * @param {Array<{fullName: string, branch: string}>|null|undefined} additionalRepos
 * @param {string} [peersDir]
 * @returns {Array<{fullName: string, branch: string, localPath: string}>}
 */
export function buildPeerLocalPaths(
  additionalRepos,
  peersDir = DEFAULT_PEERS_DIR
) {
  if (!Array.isArray(additionalRepos) || additionalRepos.length === 0) {
    return [];
  }
  const peers = [];
  for (const entry of additionalRepos) {
    const parsed = AdditionalRepoRefSchema.safeParse(entry);
    if (!parsed.success) {
      console.warn(
        "[peer-context] Skipping malformed additionalRepo entry: " +
          parsed.error.issues.map((i) => i.message).join("; ")
      );
      continue;
    }
    peers.push({
      fullName: parsed.data.fullName,
      branch: parsed.data.branch,
      localPath: path.join(
        peersDir,
        parsed.data.fullName.replaceAll("/", "--")
      ),
    });
  }
  return peers;
}

/**
 * Write `peer-repos.json` into the loop's context dir. The manifest gives the
 * agent a structured view of peer mounts so it can reference them by name +
 * absolute path. No-op when no peers are present. Best-effort: filesystem
 * errors are swallowed (caller logs).
 *
 * @param {string} contextDir Absolute path to .closedloop-ai/context
 * @param {Array<{fullName: string, branch: string, localPath: string}>} peers
 * @returns {boolean} true if a manifest was written
 */
export function writePeerReposManifest(contextDir, peers) {
  if (!Array.isArray(peers) || peers.length === 0) {
    return false;
  }
  fs.mkdirSync(contextDir, { recursive: true });
  fs.writeFileSync(
    path.join(contextDir, "peer-repos.json"),
    JSON.stringify({ peers }, null, 2)
  );
  return true;
}

/**
 * Build the "## Mounted paths" prompt footer. The footer enumerates each peer
 * by `fullName` + `branch` + absolute mount path so the model has the exact
 * paths to read from. Empty when no peers — callers append unconditionally
 * and rely on this being "" in the no-peer case.
 *
 * @param {Array<{fullName: string, branch: string, localPath: string}>} peers
 * @returns {string}
 */
export function buildMountPathsFooter(peers) {
  if (!Array.isArray(peers) || peers.length === 0) {
    return "";
  }
  const lines = peers.map(
    (p) => `- \`${p.fullName}\` @ \`${p.branch}\` → \`${p.localPath}\``
  );
  return `\n\n## Mounted paths\n\n${lines.join("\n")}\n`;
}
