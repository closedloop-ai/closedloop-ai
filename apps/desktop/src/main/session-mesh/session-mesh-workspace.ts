import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { SessionMeshWorkspace } from "@repo/api/src/types/session-mesh";
import { getShellPath } from "../../server/shell-path.js";
import { isTccProtectedPath } from "../../shared/sandbox-policy.js";
import { extractSessionMeshTicketSlugs } from "./session-mesh-send-message-relevance.js";

const run = promisify(execFile);
const SSH_ORIGIN_PATTERN = /^git@([^:]+):/;
const HTTP_ORIGIN_PATTERN = /^https?:\/\/(?:[^@/]+@)?/;
const GIT_SUFFIX_PATTERN = /\.git$/;
export type ResolvedSessionMeshWorkspace = SessionMeshWorkspace & {
  branch?: string;
  /**
   * The git toplevel every path in {@link SessionMeshWorkspace.paths} was made
   * relative to. Reported so a path discovered LATER — one a `SendMessage` body
   * named rather than one a tool edited — is relativized against the SAME root,
   * instead of against a cwd that is only sometimes the same directory.
   */
  root?: string;
};

/** Resolve repository identity from git, never from a provider's display alias. */
export async function resolveSessionMeshWorkspace(
  cwd: string,
  file?: string,
  files?: string[]
): Promise<ResolvedSessionMeshWorkspace> {
  // ISS-11914: `git` reads `.git` inside `cwd`, which raises a macOS permission
  // prompt in a TCC-protected folder. Fail the way a non-repository cwd does.
  if (isTccProtectedPath(cwd)) {
    throw new Error("Session Mesh does not resolve a TCC-protected cwd");
  }
  const env = { ...process.env, PATH: await getShellPath() };
  const canonicalCwd = await realpath(cwd);
  const inputCwd = path.resolve(cwd);
  const git = async (args: string[]) =>
    (
      await run("git", ["-C", cwd, ...args], {
        env,
        timeout: 2000,
        maxBuffer: 2 * 1024 * 1024,
      })
    ).stdout.trim();
  const [root, origin, revision, branch] = await Promise.all([
    git(["rev-parse", "--show-toplevel"]),
    git(["remote", "get-url", "origin"]),
    git(["rev-parse", "HEAD"]),
    // Detached HEAD is normal; optional branch discovery must never prevent
    // repository resolution when this lookup fails.
    git(["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => undefined),
  ]);
  // Match SSH and HTTPS clones without leaking embedded URL credentials.
  const repository = origin
    .replace(SSH_ORIGIN_PATTERN, "$1/")
    .replace(HTTP_ORIGIN_PATTERN, "")
    .replace(GIT_SUFFIX_PATTERN, "");
  const candidates = files ?? (file ? [file] : []);
  const paths = candidates
    .map((candidate) => {
      const absolute = path.resolve(cwd, candidate);
      // macOS aliases /var to /private/var. Git reports the canonical root;
      // preserve interests passed through a symlinked working directory.
      const canonical = absolute.startsWith(`${root}${path.sep}`)
        ? absolute
        : path.resolve(canonicalCwd, path.relative(inputCwd, absolute));
      return path.relative(root, canonical).split(path.sep).join("/");
    })
    .filter(
      (relative) => relative && !relative.startsWith("../") && relative !== ".."
    );
  return {
    repository,
    revision,
    paths: [...new Set(paths)].slice(0, 200),
    // The ticket slug the session's own branch names — the only symbol the main
    // process can observe rather than infer. `relevanceFor` matches a message's
    // symbols against a peer's presence symbols EXACTLY, so the slug is
    // uppercased and bare. A branch naming no slug yields an empty list: a symbol
    // that does not reflect what the session is working on routes the message to
    // a stranger, which is worse than no symbol.
    symbols: branch ? extractSessionMeshTicketSlugs(branch) : [],
    ...(branch ? { branch } : {}),
    root,
  };
}
