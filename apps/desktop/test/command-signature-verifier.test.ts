import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { stableStringify } from "@closedloop-ai/loops-api/stable-stringify";
import type { AuthorizedCommandKeyStore } from "../src/main/authorized-command-key-store.js";
import type { DesktopCommandEvent } from "../src/main/cloud-protocol.js";
import { CommandSignatureVerifier } from "../src/main/command-signature-verifier.js";
import { COMMAND_SIGNING_REJECTION_REASONS } from "../src/shared/contracts.js";

const ED25519_SPKI_PREFIX_LENGTH = Buffer.from(
  "302a300506032b6570032100",
  "hex"
).length;
const NOW_SECONDS = 1_777_728_000;

test("CommandSignatureVerifier accepts a signed command including sorted query and body hash", () => {
  const fixture = createSignedCommand({
    query: { z: "last", a: ["second", "first"] },
    body: { repoPath: "/repo", action: "status" },
  });
  const verifier = createVerifier(fixture);

  assert.deepEqual(verifier.verify(fixture.command), { ok: true });
});

test("CommandSignatureVerifier rejects query tampering after signing", () => {
  const fixture = createSignedCommand({
    query: { repo: "/repo", mode: "status" },
  });
  const verifier = createVerifier(fixture);

  assert.deepEqual(
    verifier.verify({
      ...fixture.command,
      query: { repo: "/repo", mode: "diff" },
    }),
    { ok: false, reason: COMMAND_SIGNING_REJECTION_REASONS.payloadMismatch }
  );
});

test("CommandSignatureVerifier verifies signed loop user intent via body override", () => {
  const userIntent = { documentId: "doc-1", command: "execute" };
  const fixture = createSignedCommand({
    path: "/api/gateway/symphony/loop",
    body: userIntent,
  });
  const verifier = createVerifier(fixture);
  const command: DesktopCommandEvent = {
    ...fixture.command,
    body: { loopId: "loop-1", userIntent },
  };

  assert.deepEqual(verifier.verify(command, userIntent), { ok: true });
  assert.deepEqual(createVerifier(fixture).verify(command), {
    ok: false,
    reason: COMMAND_SIGNING_REJECTION_REASONS.payloadMismatch,
  });
});

test("CommandSignatureVerifier returns exact rejection reasons", () => {
  const fixture = createSignedCommand();
  const verifier = createVerifier(fixture);

  assert.deepEqual(
    verifier.verify({
      ...fixture.command,
      signature: undefined,
    }),
    { ok: false, reason: COMMAND_SIGNING_REJECTION_REASONS.unsignedCommand }
  );
  assert.deepEqual(
    createVerifier(fixture, { noKeys: true }).verify(fixture.command),
    { ok: false, reason: COMMAND_SIGNING_REJECTION_REASONS.noKeysAuthorized }
  );
  assert.deepEqual(
    createVerifier(fixture, { authorized: false }).verify(fixture.command),
    { ok: false, reason: COMMAND_SIGNING_REJECTION_REASONS.unknownSigningKey }
  );
  assert.deepEqual(
    createVerifier(fixture, { nowSeconds: NOW_SECONDS + 600 }).verify(
      fixture.command
    ),
    {
      ok: false,
      reason: COMMAND_SIGNING_REJECTION_REASONS.staleOrReplayedCommand,
    }
  );
});

test("CommandSignatureVerifier rejects nonce replay and prunes stale restart replays by timestamp", () => {
  const fixture = createSignedCommand();
  const verifier = createVerifier(fixture);

  assert.deepEqual(verifier.verify(fixture.command), { ok: true });
  assert.deepEqual(verifier.verify(fixture.command), {
    ok: false,
    reason: COMMAND_SIGNING_REJECTION_REASONS.staleOrReplayedCommand,
  });

  const staleFixture = createSignedCommand({ timestamp: NOW_SECONDS - 60 });
  assert.deepEqual(createVerifier(staleFixture).verify(staleFixture.command), {
    ok: false,
    reason: COMMAND_SIGNING_REJECTION_REASONS.staleOrReplayedCommand,
  });
});

test("CommandSignatureVerifier rejects future skew beyond tolerance", () => {
  const fixture = createSignedCommand();
  assert.deepEqual(
    createVerifier(fixture, { nowSeconds: NOW_SECONDS - 10 }).verify(
      fixture.command
    ),
    {
      ok: false,
      reason: COMMAND_SIGNING_REJECTION_REASONS.staleOrReplayedCommand,
    }
  );
});

function createVerifier(
  fixture: SignedCommandFixture,
  options?: { authorized?: boolean; noKeys?: boolean; nowSeconds?: number }
): CommandSignatureVerifier {
  const authorized = options?.authorized ?? true;
  const store = {
    list: () =>
      options?.noKeys
        ? []
        : [
            {
              fingerprint: authorized
                ? fixture.fingerprint
                : "cl:otherfingerprint",
              publicKeyBase64: fixture.publicKeyBase64,
              ownerName: "Test User",
              ownerEmail: "test@example.com",
              authorizedAt: new Date(NOW_SECONDS * 1000).toISOString(),
            },
          ],
    get: (fingerprint: string) =>
      authorized && fingerprint === fixture.fingerprint
        ? {
            fingerprint,
            publicKeyBase64: fixture.publicKeyBase64,
            ownerName: "Test User",
            ownerEmail: "test@example.com",
            authorizedAt: new Date(NOW_SECONDS * 1000).toISOString(),
          }
        : null,
  } as unknown as AuthorizedCommandKeyStore;

  return new CommandSignatureVerifier({
    authorizedKeys: store,
    now: () => new Date((options?.nowSeconds ?? NOW_SECONDS) * 1000),
  });
}

type SignedCommandFixture = {
  command: DesktopCommandEvent;
  fingerprint: string;
  publicKeyBase64: string;
};

function createSignedCommand(
  overrides?: Partial<
    Pick<DesktopCommandEvent, "body" | "method" | "path" | "query">
  > & { timestamp?: number; nonce?: string }
): SignedCommandFixture {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyBase64 = Buffer.from(
    (
      publicKey.export({
        format: "der",
        type: "spki",
      }) as Buffer
    ).subarray(ED25519_SPKI_PREFIX_LENGTH)
  ).toString("base64");
  const commandId = "0196b1bb-7a00-7000-8000-000000000005";
  const method = overrides?.method ?? "POST";
  const path = overrides?.path ?? "/api/gateway/git";
  const query = overrides?.query ?? {};
  const body = overrides?.body ?? { action: "status" };
  const signaturePayload = stableStringify({
    commandId,
    method,
    path,
    query: canonicalQuery(query),
    bodyHash: hashCommandBody(body),
    timestamp: overrides?.timestamp ?? NOW_SECONDS,
    nonce: overrides?.nonce ?? "nonce-1",
  });
  const signature = crypto
    .sign(null, Buffer.from(signaturePayload, "utf8"), privateKey)
    .toString("base64");
  const fingerprint = "cl:testfingerprint";

  return {
    fingerprint,
    publicKeyBase64,
    command: {
      protocolVersion: "1",
      messageId: `${commandId}-message`,
      timestamp: new Date(NOW_SECONDS * 1000).toISOString(),
      commandId,
      operationId: "git_action",
      method,
      path,
      query,
      body,
      signature,
      signaturePayload,
      publicKeyFingerprint: fingerprint,
    },
  };
}

function canonicalQuery(
  query: DesktopCommandEvent["query"]
): [string, string][] {
  if (!query) {
    return [];
  }
  const entries: [string, string][] = [];
  for (const [key, value] of Object.entries(query)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        entries.push([key, item]);
      }
      continue;
    }
    entries.push([key, value]);
  }
  return entries.sort(([aKey, aValue], [bKey, bValue]) =>
    aKey === bKey ? aValue.localeCompare(bValue) : aKey.localeCompare(bKey)
  );
}

function hashCommandBody(body: unknown): string {
  return crypto
    .createHash("sha256")
    .update(stableStringify(body ?? null))
    .digest("base64url");
}
