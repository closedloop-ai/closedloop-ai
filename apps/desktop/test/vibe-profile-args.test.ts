import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
  parseVibeProfileArgs,
  VibeProfileCommand,
} from "../scripts/vibe-profile/args";
import { VibeOriginKind } from "../scripts/vibe-profile/origin-policy";

const NOW_REQUIRED_RE = /--now is required/;
const NOW_NOT_ISO_RE = /--now must be an ISO-8601 instant/;
const UNKNOWN_SEED_COMMAND_RE = /unknown command seed/;
const NO_COMMAND_RE = /unknown command \(none\)/;
const UNKNOWN_OUT_FLAG_RE = /unknown flag --out/;
const UNKNOWN_API_ORIGIN_FLAG_RE = /unknown flag --api-origin/;
const REPEATED_PROFILE_RE = /--profile given twice/;
const PROFILE_WITHOUT_VALUE_RE = /--profile needs a value/;
const NOT_A_FLAG_RE = /expected a --flag/;
const API_ORIGIN_REFUSED_RE = /--api-origin must be a loopback origin or/;
const MIXED_KINDS_RE = /must both be loopback or both be the same/;

const NOW = "2026-10-05T15:00:00.000Z";
const API = "http://localhost:4123";
const WEB = "http://127.0.0.1:4124";
const PREVIEW_API = "https://api-stage-git-feat-x.preview.stage.example";
const PREVIEW_WEB = "https://app-stage-git-feat-x.preview.stage.example";
const ORIGIN_COMMANDS = [
  VibeProfileCommand.SignIn,
  VibeProfileCommand.LaunchEnv,
  VibeProfileCommand.Launch,
] as const;

describe("parseVibeProfileArgs", () => {
  it("parses prepare with its output dir and clock", () => {
    assert.deepEqual(
      parseVibeProfileArgs([
        VibeProfileCommand.Prepare,
        "--out",
        "/tmp/p",
        "--now",
        NOW,
      ]),
      { command: VibeProfileCommand.Prepare, out: "/tmp/p", now: NOW }
    );
  });

  it("drops a pnpm `--` separator before the flags", () => {
    assert.deepEqual(
      parseVibeProfileArgs([
        "--",
        VibeProfileCommand.Counts,
        "--profile",
        "/tmp/p",
      ]),
      { command: VibeProfileCommand.Counts, profile: "/tmp/p" }
    );
  });

  it("parses sign-in, launch-env and launch with normalized loopback origins", () => {
    for (const command of ORIGIN_COMMANDS) {
      assert.deepEqual(
        parseVibeProfileArgs([
          command,
          "--profile",
          "/tmp/p",
          "--api-origin",
          `${API}/`,
          "--web-origin",
          WEB,
        ]),
        {
          command,
          profile: "/tmp/p",
          apiOrigin: API,
          webOrigin: WEB,
          originKind: VibeOriginKind.Loopback,
        }
      );
    }
  });

  it("parses sign-in, launch-env and launch against one branch preview", () => {
    for (const command of ORIGIN_COMMANDS) {
      assert.deepEqual(
        parseVibeProfileArgs([
          command,
          "--profile",
          "/tmp/p",
          "--api-origin",
          PREVIEW_API,
          "--web-origin",
          `${PREVIEW_WEB}/`,
        ]),
        {
          command,
          profile: "/tmp/p",
          apiOrigin: PREVIEW_API,
          webOrigin: PREVIEW_WEB,
          originKind: VibeOriginKind.BranchPreview,
        }
      );
    }
  });

  it("refuses an origin pair the policy refuses, for every origin command", () => {
    for (const command of ORIGIN_COMMANDS) {
      assert.throws(
        () =>
          parseVibeProfileArgs([
            command,
            "--profile",
            "/tmp/p",
            "--api-origin",
            "https://api.closedloop.ai",
            "--web-origin",
            "https://app.closedloop.ai",
          ]),
        API_ORIGIN_REFUSED_RE
      );
      assert.throws(
        () =>
          parseVibeProfileArgs([
            command,
            "--profile",
            "/tmp/p",
            "--api-origin",
            API,
            "--web-origin",
            PREVIEW_WEB,
          ]),
        MIXED_KINDS_RE
      );
    }
  });

  it("parses auth-claim with only a profile", () => {
    assert.deepEqual(
      parseVibeProfileArgs([VibeProfileCommand.AuthClaim, "--profile", "/p"]),
      { command: VibeProfileCommand.AuthClaim, profile: "/p" }
    );
    assert.throws(
      () =>
        parseVibeProfileArgs([
          VibeProfileCommand.AuthClaim,
          "--profile",
          "/p",
          "--api-origin",
          API,
        ]),
      UNKNOWN_API_ORIGIN_FLAG_RE
    );
  });

  it("refuses a prepare without --now or with a non-ISO --now", () => {
    assert.throws(
      () =>
        parseVibeProfileArgs([VibeProfileCommand.Prepare, "--out", "/tmp/p"]),
      NOW_REQUIRED_RE
    );
    assert.throws(
      () =>
        parseVibeProfileArgs([
          VibeProfileCommand.Prepare,
          "--out",
          "/tmp/p",
          "--now",
          "yesterday",
        ]),
      NOW_NOT_ISO_RE
    );
  });

  it("refuses unknown commands, unknown flags, repeated flags and missing values", () => {
    assert.throws(
      () => parseVibeProfileArgs(["seed"]),
      UNKNOWN_SEED_COMMAND_RE
    );
    assert.throws(() => parseVibeProfileArgs([]), NO_COMMAND_RE);
    assert.throws(
      () =>
        parseVibeProfileArgs([
          VibeProfileCommand.Counts,
          "--profile",
          "/a",
          "--out",
          "/b",
        ]),
      UNKNOWN_OUT_FLAG_RE
    );
    assert.throws(
      () =>
        parseVibeProfileArgs([
          VibeProfileCommand.Counts,
          "--profile",
          "/a",
          "--profile",
          "/b",
        ]),
      REPEATED_PROFILE_RE
    );
    assert.throws(
      () => parseVibeProfileArgs([VibeProfileCommand.Counts, "--profile"]),
      PROFILE_WITHOUT_VALUE_RE
    );
    assert.throws(
      () => parseVibeProfileArgs([VibeProfileCommand.Counts, "/a"]),
      NOT_A_FLAG_RE
    );
  });
});
