#!/usr/bin/env node

/**
 * Send a fake error event with diagnostic fields to a running loop.
 * Useful for testing the error diagnostics UI (FEA-228).
 *
 * Usage:
 *   node scripts/send-test-error-event.mjs <loop-id> [api-base-url]
 *
 * Examples:
 *   node scripts/send-test-error-event.mjs 019d4f3a-ca15-7090-91b3-eaf862683f77
 *   node scripts/send-test-error-event.mjs 019d4f3a-ca15-7090-91b3-eaf862683f77 http://localhost:3002
 *
 * Environment:
 *   CLOSEDLOOP_RUNNER_JWT_SECRET - JWT signing secret (defaults to local dev secret)
 *   CLOSEDLOOP_ORG_ID            - Organization ID (defaults to local dev org)
 */

import crypto from "crypto";

// --- Config ---

const loopId = process.argv[2];
if (!loopId) {
  console.error(
    "Usage: node scripts/send-test-error-event.mjs <loop-id> [api-base-url]\n" +
      "Example: node scripts/send-test-error-event.mjs 019d4f3a-ca15-7090-91b3-eaf862683f77 http://localhost:3002"
  );
  process.exit(1);
}

const apiBase = process.argv[3] ?? "http://localhost:3002";
const jwtSecret =
  process.env.CLOSEDLOOP_RUNNER_JWT_SECRET ??
  "local-dev-jwt-secret-key-for-testing-only";
const orgId =
  process.env.CLOSEDLOOP_ORG_ID ?? "019d4599-3a23-74ca-8623-47c6bc3098f9";

// --- JWT signing (HS256, no external deps) ---

function base64url(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function signJwt(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + 3600,
  };
  const segments = [
    base64url(JSON.stringify(header)),
    base64url(JSON.stringify(fullPayload)),
  ];
  const signingInput = segments.join(".");
  const signature = crypto
    .createHmac("sha256", secret)
    .update(signingInput)
    .digest();
  segments.push(base64url(signature));
  return segments.join(".");
}

// --- Build and send ---

const token = signJwt(
  {
    sub: loopId,
    jti: crypto.randomUUID(),
    aud: "closedloop-runner",
    iss: "closedloop-api",
    orgId,
  },
  jwtSecret
);

const nonce = crypto.randomUUID();
const payload = {
  type: "error",
  data: {
    code: "CONTEXT_LIMIT_EXCEEDED",
    message: "Model context window exceeded after 47 tool calls",
    timestamp: new Date().toISOString(),
    logTail: [
      "Running tool: edit_file",
      "Applying changes to src/index.ts",
      "Token count: 198432/200000",
      "Error: context length exceeded maximum of 200000 tokens",
      "Stack: at ModelClient.send (client.ts:142)",
      "  at Agent.step (agent.ts:89)",
      "  at Loop.run (loop.ts:34)",
    ].join("\n"),
    tokenUsage: { inputTokens: 189432, outputTokens: 12847 },
    diagnosticsVersion: "1.0.0",
  },
};

const url = `${apiBase}/loops/${loopId}/events`;
console.log(`POST ${url}`);

const response = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-loop-event-nonce": nonce,
  },
  body: JSON.stringify(payload),
});

const body = await response.text();
console.log(`${response.status} ${response.statusText}`);
console.log(body);
