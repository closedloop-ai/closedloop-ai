import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "vitest";
import {
  USER_DATA_DIR_ARG,
  VIBE_UNROUTABLE_RELAY_ORIGIN,
  vibeProfileLaunchEnv,
} from "../scripts/vibe-profile/launch-env";
import {
  assertProfileDirAllowed,
  type ProfileDirPolicy,
  VIBE_HARNESS_HOMES_DIR,
  vibeProfileHarnessHomes,
} from "../scripts/vibe-profile/profile-layout";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../src/main/lifecycle/loopback-port-isolation.js";
import { HARNESS_HOME_ENV_KEYS } from "./helpers/isolated-harness-homes";

const NOT_IGNORED_RE = /git does not ignore it/;
const REPOSITORY_ROOT_RE = /repository root/;

const REPO = path.resolve("/synthetic/repo");
const ORIGINS = {
  apiOrigin: "http://localhost:4123",
  webOrigin: "http://localhost:4124",
};

function policy(ignored: readonly string[]): ProfileDirPolicy {
  return {
    repoRoot: REPO,
    isIgnored: (absolutePath) =>
      ignored.some((dir) => absolutePath.startsWith(path.join(REPO, dir))),
  };
}

describe("assertProfileDirAllowed", () => {
  it("allows a directory outside the repository", () => {
    const outside = path.resolve("/synthetic/elsewhere/profile");
    assert.equal(assertProfileDirAllowed(outside, policy([])), outside);
  });

  it("does not treat a sibling whose name starts with the repo's as inside it", () => {
    const sibling = path.resolve("/synthetic/repo-profiles/p");
    assert.equal(assertProfileDirAllowed(sibling, policy([])), sibling);
  });

  it("allows a directory inside the repository that git ignores", () => {
    const ignored = path.join(REPO, ".control", "vibe", "p");
    assert.equal(
      assertProfileDirAllowed(ignored, policy([".control"])),
      ignored
    );
  });

  it("refuses a tracked location inside the repository", () => {
    assert.throws(
      () =>
        assertProfileDirAllowed(
          path.join(REPO, "apps", "p"),
          policy([".control"])
        ),
      NOT_IGNORED_RE
    );
  });

  it("refuses the repository root itself", () => {
    assert.throws(
      () => assertProfileDirAllowed(REPO, policy([""])),
      REPOSITORY_ROOT_RE
    );
  });
});

describe("vibeProfileHarnessHomes", () => {
  it("pins every collector home under the profile", () => {
    const homes = vibeProfileHarnessHomes("/synthetic/p");
    assert.deepEqual(
      Object.keys(homes).sort(),
      [...HARNESS_HOME_ENV_KEYS].sort()
    );
    for (const [key, dir] of Object.entries(homes)) {
      assert.equal(
        dir,
        path.resolve("/synthetic/p", VIBE_HARNESS_HOMES_DIR, key)
      );
    }
  });
});

describe("vibeProfileLaunchEnv", () => {
  it("sets the harness homes, the local origins, the unroutable relay and the profile", () => {
    const launch = vibeProfileLaunchEnv("/synthetic/p", ORIGINS);
    for (const [key, dir] of Object.entries(
      vibeProfileHarnessHomes("/synthetic/p")
    )) {
      assert.equal(launch.env[key], dir);
    }
    assert.equal(launch.env.CL_AUTH_API_ORIGIN, ORIGINS.apiOrigin);
    assert.equal(launch.env.CL_WEB_APP_ORIGIN, ORIGINS.webOrigin);
    assert.equal(launch.env.CL_RELAY_ORIGIN, VIBE_UNROUTABLE_RELAY_ORIGIN);
    assert.deepEqual(launch.args, [
      `${USER_DATA_DIR_ARG}${path.resolve("/synthetic/p")}`,
      E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
    ]);
  });

  it("pins CLAUDE_CONFIG_DIR to the profile's Claude home, not the launching shell's", () => {
    const launch = vibeProfileLaunchEnv("/synthetic/p", ORIGINS);
    const claudeHome = vibeProfileHarnessHomes("/synthetic/p").CLAUDE_HOME;

    assert.equal(launch.env.CLAUDE_CONFIG_DIR, claudeHome);
  });
});
