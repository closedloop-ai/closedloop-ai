import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "vitest";
import { VibeProfileCommand } from "../scripts/vibe-profile/args";
import { runVibeProfileCli } from "../scripts/vibe-profile/cli";
import { vibeProfileLaunchEnv } from "../scripts/vibe-profile/launch-env";

const NO_STORE_RE = /no Desktop store/;
const UNKNOWN_COMMAND_RE = /unknown command/;
const NOT_SIGNED_IN_RE = /is not signed in/;
const API = "http://localhost:4123";
const WEB = "http://localhost:4124";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProfile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-"));
  dirs.push(dir);
  return dir;
}

describe("runVibeProfileCli", () => {
  it("prints launch-env as the shape the vibe CLI parses", async () => {
    const profile = tempProfile();
    const result = await runVibeProfileCli([
      VibeProfileCommand.LaunchEnv,
      "--profile",
      profile,
      "--api-origin",
      API,
      "--web-origin",
      WEB,
    ]);
    assert.deepEqual(result, {
      ok: true,
      ...vibeProfileLaunchEnv(profile, { apiOrigin: API, webOrigin: WEB }),
    });
  });

  it("fails counts on a profile that was never prepared", async () => {
    await assert.rejects(
      runVibeProfileCli([
        VibeProfileCommand.Counts,
        "--profile",
        tempProfile(),
      ]),
      NO_STORE_RE
    );
  });

  it("routes launch to the launcher, which refuses a profile never signed in", async () => {
    await assert.rejects(
      runVibeProfileCli([
        VibeProfileCommand.Launch,
        "--profile",
        tempProfile(),
        "--api-origin",
        API,
        "--web-origin",
        WEB,
      ]),
      NOT_SIGNED_IN_RE
    );
  });

  it("fails an unknown command before touching anything", async () => {
    await assert.rejects(runVibeProfileCli(["reset"]), UNKNOWN_COMMAND_RE);
  });
});
