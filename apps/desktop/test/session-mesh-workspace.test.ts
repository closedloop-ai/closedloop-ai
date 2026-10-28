import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { resolveSessionMeshWorkspace } from "../src/main/session-mesh/session-mesh-workspace.js";

vi.mock("../src/server/shell-path.js", () => ({
  getShellPath: () => Promise.resolve(process.env.PATH ?? ""),
}));

it("captures real git branch lineage and omits it for a detached HEAD", async () => {
  const directory = fixtureRepository("feature/session-mesh");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  const branch = await resolveSessionMeshWorkspace(directory, "src/service.ts");
  expect(branch).toMatchObject({
    repository: "example.test/org/repo",
    branch: "feature/session-mesh",
    paths: ["src/service.ts"],
  });
  expect(branch.revision).toBe(git("rev-parse", "HEAD"));
  const nested = path.join(directory, "nested");
  mkdirSync(nested);
  expect(
    (await resolveSessionMeshWorkspace(nested, "../src/service.ts")).paths
  ).toEqual(["src/service.ts"]);
  git("checkout", "--detach", "HEAD");
  const detached = await resolveSessionMeshWorkspace(directory);
  expect(detached.repository).toBe(branch.repository);
  expect(detached.revision).toBe(branch.revision);
  expect(detached).not.toHaveProperty("branch");
});

/**
 * One fixture checkout on `branch`, so the branch name under test is a real
 * `git symbolic-ref` answer rather than a stubbed resolver field.
 */
function fixtureRepository(branch: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), "mesh-workspace-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-b", branch);
  git(
    "-c",
    "user.name=Mesh Test",
    "-c",
    "user.email=mesh@example.test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--allow-empty",
    "-m",
    "fixture"
  );
  git("remote", "add", "origin", "git@example.test:org/repo.git");
  return directory;
}

it("carries the branch ticket slug as a routable presence symbol", async () => {
  const workspace = await resolveSessionMeshWorkspace(
    fixtureRepository("fix/iss-11729-right-size"),
    "src/service.ts"
  );
  // `relevanceFor` matches a message's symbols against a peer's presence
  // symbols EXACTLY, so the slug must be published uppercased and bare.
  expect(workspace.symbols).toEqual(["ISS-11729"]);
});

it("publishes an empty symbol list rather than guessing one", async () => {
  // A branch naming no ticket, and a detached HEAD naming no branch at all. An
  // inferred symbol would route the message to a stranger.
  expect(
    (await resolveSessionMeshWorkspace(fixtureRepository("feat/no-slug-here")))
      .symbols
  ).toEqual([]);
  const detachable = fixtureRepository("fix/iss-11729-detached");
  execFileSync("git", ["-C", detachable, "checkout", "--detach", "HEAD"], {
    encoding: "utf8",
  });
  const detached = await resolveSessionMeshWorkspace(detachable);
  expect(detached).not.toHaveProperty("branch");
  expect(detached.symbols).toEqual([]);
});
