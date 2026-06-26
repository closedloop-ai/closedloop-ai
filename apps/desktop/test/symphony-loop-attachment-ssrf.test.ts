import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import {
  SKIPPED_ATTACHMENTS_WARNING_FILE,
  writeArtifactsForExecuteOrAmend,
} from "../src/server/operations/symphony-loop.js";

const originalFetch = globalThis.fetch;
const tempDirsToClean: string[] = [];

afterEach(async () => {
  globalThis.fetch = originalFetch;
  for (const dir of tempDirsToClean.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("denied attachment URLs do not call fetch and write safe warning diagnostics", async () => {
  const workDir = await makeWorkDir();
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("fetch should not be called");
  };

  await writeArtifactsForExecuteOrAmend(workDir, [], undefined, [
    makeAttachment({
      id: "att-denied",
      filename: "secret.txt",
      signedUrl:
        "http://169.254.169.254/latest/meta-data?X-Amz-Credential=secret",
    }),
  ] as never);

  assert.equal(fetchCalls, 0);
  const warning = await readSkippedWarning(workDir);
  assert.equal(warning.allAttachmentsSkipped, true);
  assert.deepEqual(warning.skippedAttachments, [
    {
      id: "att-denied",
      reason: "unsupported_protocol",
    },
  ]);

  const serialized = JSON.stringify(warning);
  assert.equal(serialized.includes("169.254.169.254"), false);
  assert.equal(serialized.includes("latest/meta-data"), false);
  assert.equal(serialized.includes("X-Amz-Credential"), false);
  assert.equal(serialized.includes("secret"), false);
});

test("approved S3 attachment URLs fetch with redirect following disabled", async () => {
  const workDir = await makeWorkDir();
  const calls: Array<{ url: string; redirect?: RequestRedirect }> = [];
  globalThis.fetch = async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    calls.push({ url: String(input), redirect: init?.redirect });
    return new Response("ok", { status: 200 });
  };

  await writeArtifactsForExecuteOrAmend(workDir, [], undefined, [
    makeAttachment({
      id: "att-allowed",
      filename: "allowed.txt",
      signedUrl:
        "https://closedloop-files.s3.us-east-1.amazonaws.com/user-123/allowed.txt?X-Amz-Signature=secret",
      sizeBytes: 2,
    }),
  ] as never);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, "error");
  assert.equal(
    calls[0].url,
    "https://closedloop-files.s3.us-east-1.amazonaws.com/user-123/allowed.txt?X-Amz-Signature=secret"
  );
  const written = await fs.readFile(
    path.join(workDir, "attachments", "att-allowed-allowed.txt"),
    "utf-8"
  );
  assert.equal(written, "ok");
});

test("redirecting approved attachment responses are not followed", async () => {
  const workDir = await makeWorkDir();
  const attemptedRedirects: RequestRedirect[] = [];
  globalThis.fetch = async (
    _input: string | URL | Request,
    init?: RequestInit
  ) => {
    attemptedRedirects.push(init?.redirect ?? "follow");
    throw new TypeError("redirect disabled");
  };

  await writeArtifactsForExecuteOrAmend(workDir, [], undefined, [
    makeAttachment({
      id: "att-redirect",
      filename: "redirect.txt",
      signedUrl:
        "https://closedloop-files.s3.us-east-1.amazonaws.com/redirect.txt?X-Amz-Signature=secret",
    }),
  ] as never);

  assert.deepEqual(attemptedRedirects, ["error"]);
  await assert.rejects(
    fs.stat(path.join(workDir, "attachments", "att-redirect-redirect.txt"))
  );
});

async function makeWorkDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "attachment-ssrf-"));
  tempDirsToClean.push(dir);
  return dir;
}

function makeAttachment(overrides: {
  id: string;
  filename: string;
  signedUrl: string;
  sizeBytes?: number;
}) {
  return {
    id: overrides.id,
    filename: overrides.filename,
    signedUrl: overrides.signedUrl,
    signedUrlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    sizeBytes: overrides.sizeBytes ?? 10,
  };
}

async function readSkippedWarning(workDir: string): Promise<{
  allAttachmentsSkipped: boolean;
  skippedAttachments: Array<{ id: string; reason: string }>;
}> {
  const raw = await fs.readFile(
    path.join(workDir, SKIPPED_ATTACHMENTS_WARNING_FILE),
    "utf-8"
  );
  return JSON.parse(raw);
}
