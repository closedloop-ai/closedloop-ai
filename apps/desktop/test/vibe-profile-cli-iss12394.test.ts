import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareVibeProfile: vi.fn(),
  buildVibeCorpusStore: vi.fn(),
  vibeProfileAuthClaim: vi.fn(),
  signInVibeProfile: vi.fn(),
}));

vi.mock("../scripts/vibe-profile/prepare", () => ({
  prepareVibeProfile: mocks.prepareVibeProfile,
  buildVibeCorpusStore: mocks.buildVibeCorpusStore,
}));
vi.mock("../scripts/vibe-profile/auth-claim", () => ({
  vibeProfileAuthClaim: mocks.vibeProfileAuthClaim,
}));
vi.mock("../scripts/vibe-profile/sign-in", () => ({
  signInVibeProfile: mocks.signInVibeProfile,
}));

import { VibeProfileCommand } from "../scripts/vibe-profile/args";
import { runVibeProfileCli } from "../scripts/vibe-profile/cli";
import { VibeOriginKind } from "../scripts/vibe-profile/origin-policy";
import {
  VIBE_PROFILE_FILE,
  vibeProfilePath,
} from "../scripts/vibe-profile/profile-layout";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { insertSqliteSession } from "./sqlite-session-fixtures.js";

const NOW = "2026-10-07T00:00:00.000Z";
const API = "http://localhost:4123";
const WEB = "http://localhost:4124";
const OUT = "synthetic-out";
const dirs: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProfile(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vibe-cli-12394-"));
  dirs.push(dir);
  return dir;
}

describe("runVibeProfileCli routing", () => {
  it("routes prepare to prepareVibeProfile with --out and --now and returns its result unchanged", async () => {
    mocks.prepareVibeProfile.mockResolvedValue({ ok: true, marker: "prep" });

    const result = await runVibeProfileCli([
      VibeProfileCommand.Prepare,
      "--out",
      OUT,
      "--now",
      NOW,
    ]);

    expect(result).toEqual({ ok: true, marker: "prep" });
    expect(mocks.prepareVibeProfile).toHaveBeenCalledWith(
      OUT,
      NOW,
      expect.any(Function)
    );
    expect(mocks.buildVibeCorpusStore).not.toHaveBeenCalled();
  });

  it("routes build-store to buildVibeCorpusStore, not prepare", async () => {
    mocks.buildVibeCorpusStore.mockResolvedValue({ ok: true, marker: "build" });

    const result = await runVibeProfileCli([
      VibeProfileCommand.BuildStore,
      "--out",
      OUT,
      "--now",
      NOW,
    ]);

    expect(result).toEqual({ ok: true, marker: "build" });
    expect(mocks.buildVibeCorpusStore).toHaveBeenCalledWith(
      OUT,
      NOW,
      expect.any(Function)
    );
    expect(mocks.prepareVibeProfile).not.toHaveBeenCalled();
  });

  it("returns the bare auth claim with no ok key", async () => {
    mocks.vibeProfileAuthClaim.mockReturnValue({ claim: "bare" });

    const result = await runVibeProfileCli([
      VibeProfileCommand.AuthClaim,
      "--profile",
      "synthetic-profile",
    ]);

    expect(result).toEqual({ claim: "bare" });
    expect(mocks.vibeProfileAuthClaim).toHaveBeenCalledWith(
      "synthetic-profile"
    );
  });

  it("signs in with the parsed origins and reports only ok, dropping the sign-in result", async () => {
    mocks.signInVibeProfile.mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });

    const result = await runVibeProfileCli([
      VibeProfileCommand.SignIn,
      "--profile",
      "synthetic-profile",
      "--api-origin",
      API,
      "--web-origin",
      WEB,
    ]);

    expect(result).toEqual({ ok: true });
    expect(mocks.signInVibeProfile).toHaveBeenCalledWith(
      "synthetic-profile",
      expect.objectContaining({
        apiOrigin: API,
        webOrigin: WEB,
        originKind: VibeOriginKind.Loopback,
      }),
      expect.any(Function)
    );
  });

  it("writes progress from the log callback to stderr with the vibe-profile prefix", async () => {
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        writes.push(String(chunk));
        return true;
      });
    mocks.prepareVibeProfile.mockImplementation(
      (_out: string, _now: string, log: (message: string) => void) => {
        log("hello");
        return Promise.resolve({ ok: true });
      }
    );
    try {
      await runVibeProfileCli([
        VibeProfileCommand.Prepare,
        "--out",
        OUT,
        "--now",
        NOW,
      ]);
    } finally {
      spy.mockRestore();
    }

    expect(writes).toEqual(["[vibe-profile] hello\n"]);
  });

  it("counts every model's rows in the profile's store", async () => {
    const profile = tempProfile();
    const db = await openSqliteAgentDatabase({
      dataDir: vibeProfilePath(profile, VIBE_PROFILE_FILE.Store),
      detectBillingMode: () => "api",
    });
    try {
      await insertSqliteSession(db, "s1");
    } finally {
      await db.close();
    }

    const result = await runVibeProfileCli([
      VibeProfileCommand.Counts,
      "--profile",
      profile,
    ]);

    expect(result.ok).toBe(true);
    expect(result.rowCounts).toEqual(expect.objectContaining({ Session: 1 }));
  });
});
