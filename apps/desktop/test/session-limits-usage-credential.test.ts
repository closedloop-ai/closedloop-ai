import assert from "node:assert/strict";
import { test } from "node:test";

import {
  readUsageAccessToken,
  type UsageCredentialDeps,
  usageCredentialPath,
} from "../src/main/session-limits/usage-credential.js";

const TOKEN = "sk-ant-oat01-TEST-TOKEN-VALUE";
const NOW = 1_800_000_000_000;

function deps(
  overrides: Partial<UsageCredentialDeps> & { files?: Record<string, string> }
): UsageCredentialDeps {
  const files = overrides.files ?? {};
  return {
    env: overrides.env ?? {},
    homeDir: overrides.homeDir ?? "/home/tester",
    readFileText: overrides.readFileText ?? ((p: string) => files[p] ?? null),
    joinPath: overrides.joinPath ?? ((...s: string[]) => s.join("/")),
    now: overrides.now ?? (() => NOW),
  };
}

test("reads the access token from <configDir>/.credentials.json", () => {
  const d = deps({
    files: {
      "/home/tester/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 60_000 },
      }),
    },
  });
  assert.equal(readUsageAccessToken(d), TOKEN);
});

test("honors $CLAUDE_CONFIG_DIR for a relocated profile", () => {
  const d = deps({
    env: { CLAUDE_CONFIG_DIR: "/custom/cfg" },
    files: {
      "/custom/cfg/.credentials.json": JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN },
      }),
    },
  });
  assert.equal(usageCredentialPath(d), "/custom/cfg/.credentials.json");
  assert.equal(readUsageAccessToken(d), TOKEN);
});

test("no credential file → null (feature hidden, not an error)", () => {
  assert.equal(readUsageAccessToken(deps({ files: {} })), null);
});

test("an expired access token → null rather than a doomed request", () => {
  const d = deps({
    files: {
      "/home/tester/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW - 1 },
      }),
    },
  });
  assert.equal(readUsageAccessToken(d), null);
});

test("a missing expiresAt is not treated as expired (server is the authority)", () => {
  const d = deps({
    files: {
      "/home/tester/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: { accessToken: TOKEN },
      }),
    },
  });
  assert.equal(readUsageAccessToken(d), TOKEN);
});

test("malformed JSON and wrong shapes degrade to null, never throw", () => {
  for (const body of [
    "not json at all",
    "{}",
    JSON.stringify({ claudeAiOauth: {} }),
    JSON.stringify({ claudeAiOauth: { accessToken: "" } }),
    JSON.stringify({ claudeAiOauth: { accessToken: 42 } }),
    JSON.stringify({ claudeAiOauth: null }),
    JSON.stringify([1, 2, 3]),
  ]) {
    const d = deps({
      files: { "/home/tester/.claude/.credentials.json": body },
    });
    assert.equal(readUsageAccessToken(d), null, `body: ${body}`);
  }
});

test("unknown sibling keys are tolerated (peer-version skew, non-strict schema)", () => {
  const d = deps({
    files: {
      "/home/tester/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: {
          accessToken: TOKEN,
          refreshToken: "sk-ant-ort01-REFRESH",
          subscriptionType: "max",
          someFutureField: { nested: true },
        },
        anotherTopLevelKey: "future",
      }),
    },
  });
  assert.equal(readUsageAccessToken(d), TOKEN);
});

test("a throwing readFileText degrades to null instead of propagating", () => {
  const d = deps({
    readFileText: () => {
      throw new Error(
        "EACCES: permission denied, open '/home/tester/.claude/.credentials.json'"
      );
    },
  });
  assert.doesNotThrow(() => readUsageAccessToken(d));
  assert.equal(readUsageAccessToken(d), null);
});

test("the refresh token is never returned, only the access token", () => {
  const d = deps({
    files: {
      "/home/tester/.claude/.credentials.json": JSON.stringify({
        claudeAiOauth: {
          accessToken: TOKEN,
          refreshToken: "sk-ant-ort01-SECRET-REFRESH",
        },
      }),
    },
  });
  const resolved = readUsageAccessToken(d);
  assert.equal(resolved, TOKEN);
  assert.ok(!String(resolved).includes("SECRET-REFRESH"));
});
