import assert from "node:assert/strict";
import os from "node:os";
import { VIBE_SEED_MACHINE_NAME } from "@repo/api/src/vibe-seed-corpus";
import { afterEach, describe, test } from "vitest";
import { vibeProfileLaunchEnv } from "../scripts/vibe-profile/launch-env";
import {
  DESKTOP_MACHINE_NAME_ENV,
  resolveDesktopMachineName,
} from "../src/main/machine-name.js";
import { getSharedAgentSessions } from "../src/main/session/shared-agent-sessions-api.js";
import {
  createFakeSource,
  cursor,
  session,
} from "./shared-agent-sessions-test-helpers.js";

const ORIGINS = {
  apiOrigin: "http://localhost:3201",
  webOrigin: "http://localhost:3200",
};
const originalOverride = process.env[DESKTOP_MACHINE_NAME_ENV];

afterEach(() => {
  if (originalOverride === undefined) {
    Reflect.deleteProperty(process.env, DESKTOP_MACHINE_NAME_ENV);
  } else {
    process.env[DESKTOP_MACHINE_NAME_ENV] = originalOverride;
  }
});

describe("resolveDesktopMachineName", () => {
  test("reports the OS hostname when no override is set", () => {
    assert.equal(resolveDesktopMachineName({}), os.hostname());
  });

  test("reports the override, trimmed, when one is set", () => {
    assert.equal(
      resolveDesktopMachineName({
        [DESKTOP_MACHINE_NAME_ENV]: "  studio-01  ",
      }),
      "studio-01"
    );
  });

  test("treats a blank override as unset", () => {
    assert.equal(
      resolveDesktopMachineName({ [DESKTOP_MACHINE_NAME_ENV]: "   " }),
      os.hostname()
    );
  });

  test("the local Sessions list names the overridden machine", async () => {
    process.env[DESKTOP_MACHINE_NAME_ENV] = "studio-01";
    const source = createFakeSource({
      cursorRows: [cursor("session-a", "2026-01-01T00:00:00.000Z")],
      sessions: { "session-a": session({ id: "session-a" }) },
    });

    const list = await getSharedAgentSessions(source);

    assert.equal(list.items[0]?.computeTarget.machineName, "studio-01");
  });
});

describe("vibe profile machine name", () => {
  test("the vibe Desktop reports the machine the web seed syncs its sessions under", () => {
    const { env } = vibeProfileLaunchEnv("/synthetic/profile", ORIGINS);

    assert.equal(env[DESKTOP_MACHINE_NAME_ENV], VIBE_SEED_MACHINE_NAME);
    assert.notEqual(env[DESKTOP_MACHINE_NAME_ENV], os.hostname());
  });
});
