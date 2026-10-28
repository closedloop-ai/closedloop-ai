/**
 * @file hello-ack-minting-origin.test.ts
 * @description ISS-9081 — the `desktop.hello.ack` wire contract for the origin
 * that minted the compute target.
 *
 * The parse is where both version-skew directions are decided, so it is pinned
 * apart from the adoption guard it feeds (`session-sync-identity-adapter.test.ts`).
 * An older relay sends no field and the parser must produce no key — `remember`
 * reads the key's PRESENCE, and a key holding `undefined` is a statement it
 * cannot use. A current relay's stamp reaches an older desktop whose parser
 * predates the field entirely, and there the only way the stamp could hurt is
 * by displacing something that build already reads.
 *
 * Its own file rather than appended to `cloud-socket-presence.test.ts`, which
 * sits against the 1000-line ceiling.
 */
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { createRetainedComputeTargetIdentity } from "../src/main/agent-sync/retained-compute-target-identity.js";
import { parseDesktopHelloAck } from "../src/main/cloud/cloud-socket-hello-ack.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import { adoptedFromHelloAckFrame } from "./helpers/hello-ack-adoption.js";

describe("ISS-9081: desktop.hello.ack minting origin", () => {
  test("ISS-9081: parseDesktopHelloAck carries a stated minting origin and OMITS an absent one", () => {
    const stated = parseDesktopHelloAck({
      computeTargetId: "target-1",
      mintingApiOrigin: "https://api.origin-a.test",
    });
    assert.ok(stated);
    assert.equal(stated.mintingApiOrigin, "https://api.origin-a.test");

    // The KEY has to be absent, not present-and-undefined. `remember` reads the
    // difference: no statement falls back to stamping the current origin, and a
    // statement it cannot use must not become a recorded null, which is
    // "elsewhere" to every origin and would dark the lane. A `null` on the wire
    // is a malformed statement, not a statement of nothing.
    for (const malformed of [
      {},
      { mintingApiOrigin: null },
      { mintingApiOrigin: "" },
      { mintingApiOrigin: "   " },
      { mintingApiOrigin: 42 },
      { mintingApiOrigin: { href: "https://api.origin-a.test" } },
    ]) {
      const ack = parseDesktopHelloAck({
        computeTargetId: "target-1",
        ...malformed,
      });
      assert.ok(ack);
      assert.equal(
        "mintingApiOrigin" in ack,
        false,
        `must not be carried: ${JSON.stringify(malformed)}`
      );
    }
  });

  test("ISS-9081: a stamped ack displaces nothing an older desktop already reads", () => {
    // The `current relay -> older desktop` skew arm. An older build's parser is
    // this one minus the minting-origin line, and it whitelists rather than
    // rejects — the identity-fields case above pins that unknown keys are
    // dropped, not fatal. So the only way the stamp could hurt an older desktop
    // is by displacing a field it does read; this asserts every one survives.
    const ack = parseDesktopHelloAck({
      computeTargetId: "target-1",
      sessionId: "session-1",
      serverTime: "2026-05-11T00:00:00.000Z",
      serverCapabilities: {
        computeTargetSigning: true,
        agentSessionSync: true,
      },
      resumeFromSequence: { "cmd-1": 2 },
      mintingApiOrigin: "https://api.origin-a.test",
    });

    assert.ok(ack);
    assert.equal(ack.computeTargetId, "target-1");
    assert.equal(ack.sessionId, "session-1");
    assert.equal(ack.serverTime, "2026-05-11T00:00:00.000Z");
    assert.deepEqual(ack.serverCapabilities, {
      agentSessionSync: true,
    });
    assert.deepEqual(ack.resumeFromSequence, { "cmd-1": 2 });
  });
});

const UNPARSEABLE_ORIGIN_WARNING = /unparseable mintingApiOrigin/;

describe("ISS-9081: logging an origin the desktop cannot parse", () => {
  test("ISS-9081: an unparseable stated origin is logged as one inert, escaped token", () => {
    gatewayLog.clear();
    const retained = createRetainedComputeTargetIdentity();

    // Reachable input, not a type-forbidden one: the parse only checks that
    // `mintingApiOrigin` is a non-empty string, so every byte past that is
    // unvalidated peer data arriving on a line-oriented sink (whitlockk, #6587).
    // A newline forges a whole log line; an ESC rewrites the console around it.
    retained.remember(
      null,
      "https://api.origin-a.test",
      "target-1",
      "not a url\nWARN [agent-sync] forged line\u001b[31m"
    );

    const warned = gatewayLog
      .getEntries()
      .filter((entry) => entry.level === "warn");
    assert.equal(warned.length, 1);
    const { message } = warned[0];

    // The refusal still has to be diagnosable, so assert the message names the
    // case before asserting how it carries the value.
    assert.match(message, UNPARSEABLE_ORIGIN_WARNING);
    // The defect: the raw control bytes must not reach the sink.
    assert.equal(message.includes("\n"), false, "forged a second log line");
    assert.equal(message.includes("\u001b"), false, "carried a raw escape");
    // The value is escaped rather than dropped — an operator still needs to see
    // what the peer actually sent.
    assert.ok(message.includes(String.raw`\n`));
    assert.ok(message.includes(String.raw`\u001b`));
    assert.ok(message.includes("not a url"));
  });
});

const MISMATCHED_ORIGIN_WARNING =
  /stated a minting origin this profile does not post to/;
const SIGNED_IN = { organizationId: "org-1", userId: "user-1" };

describe("ISS-9081: logging a stated origin this profile does not post to", () => {
  test("ISS-9081: a stated origin the profile does not post to is warned, and IS the refusal", () => {
    // The state that ends in a dark lane (marisolashgrove, #6587): the relay's
    // `CLOSEDLOOP_API_URL` and this profile's `apiOrigin` are set
    // independently, so this pairing can arise with no operator action to
    // correlate it with — unlike the ISS-8702 refusal, which only followed an
    // edit to `apiOrigin`.
    gatewayLog.clear();
    const retained = createRetainedComputeTargetIdentity();

    retained.remember(
      SIGNED_IN,
      "https://api.origin-b.test",
      "target-1",
      "https://api.origin-a.test"
    );

    const warned = gatewayLog
      .getEntries()
      .filter((entry) => entry.level === "warn");
    assert.equal(warned.length, 1);
    const { message } = warned[0];
    assert.match(message, MISMATCHED_ORIGIN_WARNING);
    // An operator needs all three to act on the line: which target, what the
    // peer said, and what this profile is pointed at.
    assert.ok(message.includes("target-1"), message);
    assert.ok(message.includes("https://api.origin-a.test"), message);
    assert.ok(message.includes("https://api.origin-b.test"), message);

    // The warning describes a REAL refusal, not a hypothetical one: the live id
    // is the one just recorded, so the origin gate returns null for it.
    assert.equal(
      retained.resolve(SIGNED_IN, "https://api.origin-b.test", "target-1"),
      null
    );
  });

  test("ISS-9081: the same environment spelled differently is neither warned nor refused", () => {
    // The warn is conditional and compares KEYS. Case, a trailing slash, and the
    // scheme's default port all normalize away, so an operator does not get a
    // fleet of lines for a cosmetic difference — and, more to the point, the
    // lane is not refused for one either.
    gatewayLog.clear();
    const retained = createRetainedComputeTargetIdentity();

    retained.remember(
      SIGNED_IN,
      "https://api.origin-a.test/",
      "target-1",
      "https://API.Origin-A.test:443"
    );

    assert.deepEqual(
      gatewayLog.getEntries().filter((entry) => entry.level === "warn"),
      []
    );
    assert.equal(
      retained.resolve(SIGNED_IN, "https://api.origin-a.test/", "target-1"),
      "target-1"
    );
  });
});

/**
 * ISS-9152: the direct-connect API server (`apps/api/lib/desktop-gateway-socket-server.ts`)
 * now states its own minting origin, because it answers `desktop.hello` without
 * the relay that stamps relayed acks. The desktop has one gateway socket client
 * and one ack handler for both transports, so the frame is the only thing that
 * differs: these are shaped as that server emits them — its `toEnvelope` keys
 * and server capabilities, no relay in between — and driven through the real
 * handler into the adoption guard.
 */
describe("ISS-9152: a direct-transport ack arms the same adoption guard", () => {
  const ORIGIN_A = "https://api.origin-a.test";
  const ORIGIN_B = "https://api.origin-b.test";
  const directAck = (
    stated: Record<string, unknown>
  ): Record<string, unknown> => ({
    computeTargetId: "target-direct-1",
    sessionId: "session-direct-1",
    serverTime: "2026-09-11T00:00:00.000Z",
    serverCapabilities: { agentSessionSync: true, computeTargetSigning: true },
    protocolVersion: "1",
    messageId: "message-direct-1",
    timestamp: "2026-09-11T00:00:00.000Z",
    ...stated,
  });

  test("ISS-9152: a direct ack stating origin A is refused to a profile posting to origin B", () => {
    assert.equal(
      adoptedFromHelloAckFrame(
        directAck({ mintingApiOrigin: ORIGIN_A }),
        ORIGIN_B,
        SIGNED_IN
      ),
      null,
      "the crossed pairing must be refused on the direct transport too"
    );
    assert.equal(
      adoptedFromHelloAckFrame(
        directAck({ mintingApiOrigin: ORIGIN_B }),
        ORIGIN_B,
        SIGNED_IN
      ),
      "target-direct-1",
      "and the same frame naming the origin this profile posts to is adopted"
    );
  });

  test("ISS-9152: a direct ack that states no origin, as an older API sends, adopts as before", () => {
    assert.equal(
      adoptedFromHelloAckFrame(directAck({}), ORIGIN_B, SIGNED_IN),
      "target-direct-1"
    );
  });
});
