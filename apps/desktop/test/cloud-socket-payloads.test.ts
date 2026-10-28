import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { PROTOCOL_VERSION } from "../src/main/cloud/cloud-protocol.js";
import {
  asFiniteInteger,
  asMethod,
  asNonEmptyString,
  asObject,
  asQueryRecord,
  asStringRecord,
  createEnvelope,
  formatObjectKeysForLog,
  formatPrimitiveForLog,
  hashAllowedDirectories,
  looksLikeAuthError,
  parseDesktopCommand,
} from "../src/main/cloud/cloud-socket-payloads.js";

describe("cloud socket payload coercion", () => {
  test("creates protocol envelopes and stable directory hashes", () => {
    const first = createEnvelope();
    const second = createEnvelope();

    assert.equal(first.protocolVersion, PROTOCOL_VERSION);
    assert.notEqual(first.messageId, second.messageId);
    assert.equal(Number.isFinite(Date.parse(first.timestamp)), true);
    assert.equal(
      hashAllowedDirectories(["/z", "/a"]),
      hashAllowedDirectories(["/a", "/z"])
    );
    assert.notEqual(
      hashAllowedDirectories(["/a"]),
      hashAllowedDirectories(["/b"])
    );
  });

  test("normalizes primitive helper inputs without inventing values", () => {
    assert.deepEqual(asObject(null), {});
    assert.deepEqual(asObject("value"), {});
    assert.deepEqual(asObject({ value: 1 }), { value: 1 });
    assert.equal(asNonEmptyString("  value  "), "value");
    assert.equal(asNonEmptyString("   "), null);
    assert.equal(asNonEmptyString(1), null);
    assert.equal(asFiniteInteger(3.9), 3);
    assert.equal(asFiniteInteger(0), 0);
    assert.equal(asFiniteInteger(-1), null);
    assert.equal(asFiniteInteger(Number.POSITIVE_INFINITY), null);
    assert.equal(asFiniteInteger("3"), null);
    assert.equal(asMethod("post"), "POST");
    assert.equal(asMethod("get"), "GET");
    assert.equal(asMethod("put"), "PUT");
    assert.equal(asMethod("delete"), "DELETE");
    assert.equal(asMethod("options"), null);
    assert.equal(asMethod(null), null);
  });

  test("formats diagnostic values deterministically", () => {
    assert.equal(formatObjectKeysForLog({ z: 1, a: 2 }), "a,z");
    assert.equal(formatObjectKeysForLog({}), "none");
    assert.equal(formatPrimitiveForLog(null), "null");
    assert.equal(formatPrimitiveForLog(false), "false");
    assert.equal(formatPrimitiveForLog(7), "7");
    assert.equal(formatPrimitiveForLog("value"), "value");
    assert.equal(formatPrimitiveForLog(undefined), "undefined");
    assert.equal(formatPrimitiveForLog({}), "object");
    assert.equal(
      formatPrimitiveForLog(() => undefined),
      "function"
    );
  });

  test("filters header and query records at the version-skewed boundary", () => {
    assert.equal(asStringRecord(null), null);
    assert.equal(asStringRecord([]), null);
    assert.equal(
      asStringRecord(() => undefined),
      null
    );
    assert.deepEqual(asStringRecord({ keep: "yes", drop: 1 }), {
      keep: "yes",
    });
    assert.equal(asQueryRecord("query"), null);
    assert.equal(asQueryRecord([]), null);
    assert.equal(
      asQueryRecord(() => undefined),
      null
    );
    assert.deepEqual(
      asQueryRecord({
        scalar: "one",
        list: ["one", "two"],
        empty: [],
        mixed: ["one", 2],
        number: 3,
      }),
      { scalar: "one", list: ["one", "two"], empty: [] }
    );
  });

  test("rejects commands missing any required gateway identity", () => {
    const valid = {
      commandId: "command-1",
      operationId: "operation-1",
      method: "get",
      path: "/api/gateway/health",
    };

    for (const key of ["commandId", "operationId", "method", "path"] as const) {
      assert.equal(parseDesktopCommand({ ...valid, [key]: undefined }), null);
    }
    assert.equal(parseDesktopCommand({ ...valid, path: "/api/health" }), null);
    assert.equal(parseDesktopCommand(null), null);
  });

  test("pins the unnormalized gateway path, and the timeout now bounded by ISS-8233", () => {
    const valid = {
      commandId: "command-1",
      operationId: "operation-1",
      method: "get",
      path: "/api/gateway/health",
    };

    // The path assertion still pins current behavior and still looks wrong: the
    // gateway namespace check is a raw `startsWith`, so a traversal path is
    // accepted here and only normalized later, by `new URL` in the executor —
    // which resolves it to `/health`, outside the namespace this check guards.
    // Raised by whitlockk on PR #5520; that half is the security-critical gateway
    // boundary owned by ISS-4513/ISS-4514 and is deliberately unchanged here.
    assert.equal(
      parseDesktopCommand({ ...valid, path: "/api/gateway/../../health" })
        ?.path,
      "/api/gateway/../../health"
    );
    // The timeout half of that tripwire was the other bug whitlockk named, and
    // ISS-8233 is the ticket that closes it: a skewed value used to survive to a
    // `setTimeout` that collapses anything above 2_147_483_647 to 1ms, turning
    // the longest expressible timeout into an immediate abort. It is now capped
    // at the ceiling instead of riding through.
    assert.equal(
      parseDesktopCommand({ ...valid, timeoutMs: Number.MAX_SAFE_INTEGER })
        ?.timeoutMs,
      2_147_483_647
    );
  });

  test("projects valid commands while omitting malformed optional fields", () => {
    const command = parseDesktopCommand({
      commandId: " command-1 ",
      operationId: "operation-1",
      method: "patch",
      path: "/api/gateway/files",
      headers: { authorization: "Bearer token", ignored: 1 },
      query: { tag: ["one", "two"], ignored: ["one", 2] },
      body: { value: true },
      timeoutMs: 99.8,
      queuedAt: " 2026-08-20T00:00:00.000Z ",
      lockKey: " ",
      requiresApproval: "yes",
      approvalReason: " required ",
      signature: " signature ",
      signaturePayload: " signed payload ",
      publicKeyFingerprint: " fingerprint ",
    });

    assert.ok(command);
    assert.equal(command.commandId, "command-1");
    assert.equal(command.method, "PATCH");
    assert.deepEqual(command.headers, { authorization: "Bearer token" });
    assert.deepEqual(command.query, { tag: ["one", "two"] });
    assert.deepEqual(command.body, { value: true });
    assert.equal(command.timeoutMs, 99);
    assert.equal(command.queuedAt, "2026-08-20T00:00:00.000Z");
    assert.equal(command.lockKey, undefined);
    assert.equal(command.requiresApproval, true);
    assert.equal(command.approvalReason, "required");
    // ISS-12784: an older server still signs commands; the fields are dropped.
    assert.equal("signature" in command, false);
    assert.equal("signaturePayload" in command, false);
    assert.equal("publicKeyFingerprint" in command, false);
  });

  test("recognizes only explicit structured or textual auth failures", () => {
    assert.equal(looksLikeAuthError("unauthorized"), false);
    assert.equal(looksLikeAuthError({ data: { statusCode: 401 } }), false);
    assert.equal(
      looksLikeAuthError(new Error("transport token missing")),
      false
    );
    assert.equal(
      looksLikeAuthError(Object.assign(new Error("failed"), { data: null })),
      false
    );
    assert.equal(looksLikeAuthError(new Error("request unauthorized")), true);

    const status = Object.assign(new Error("failed"), {
      data: { status: 403 },
    });
    assert.equal(looksLikeAuthError(status), true);

    const statusCode = Object.assign(new Error("failed"), {
      data: { statusCode: 401 },
    });
    assert.equal(looksLikeAuthError(statusCode), true);

    const statusCodeWins = Object.assign(new Error("failed"), {
      data: { statusCode: 500, status: 401 },
    });
    assert.equal(looksLikeAuthError(statusCodeWins), false);

    const dataMessage = Object.assign(new Error("failed"), {
      data: "FORBIDDEN by relay",
    });
    assert.equal(looksLikeAuthError(dataMessage), true);

    const nonStringData = Object.assign(new Error("failed"), {
      data: { toString: () => "unauthorized" },
    });
    assert.equal(looksLikeAuthError(nonStringData), false);
  });
});

describe("desktop command timeout clamping (ISS-8233)", () => {
  const valid = {
    commandId: "command-1",
    operationId: "operation-1",
    method: "get",
    path: "/api/gateway/health",
  };

  const timeoutOf = (timeoutMs: unknown) =>
    parseDesktopCommand({ ...valid, timeoutMs })?.timeoutMs;

  test("bounds a timeout at both ends without rejecting the command", () => {
    // The desktop half of the cross-repo fix. The cloud clamps before dispatch,
    // but an older cloud keeps sending an unclamped value to an upgraded
    // desktop, so the boundary has to hold on its own.
    assert.equal(timeoutOf(2_147_483_648), 2_147_483_647);
    assert.equal(timeoutOf(1e308), 2_147_483_647);
    // Flooring, not dropping: truncating 0.5 to 0 made the executor's `> 0`
    // check fail and arm no timeout at all, reinstating the unbounded hang
    // FEA-2848 removed. Asserting `undefined` here would pin that bug.
    assert.equal(timeoutOf(0.5), 1);
    // `0` and negatives are dropped rather than floored — they carry no
    // short-timeout intent, and a floored 1 would abort an otherwise valid
    // command ~1ms after dispatch. This is what an older cloud sends.
    assert.equal(timeoutOf(0), undefined);
    assert.equal(timeoutOf(-5), undefined);
    // A command carrying a timeout the boundary dislikes is still delivered.
    assert.equal(
      parseDesktopCommand({ ...valid, timeoutMs: -5 })?.method,
      "GET"
    );
  });

  test("leaves an ordinary or absent timeout exactly as it was", () => {
    assert.equal(timeoutOf(30_000), 30_000);
    assert.equal(timeoutOf(99.8), 99);
    assert.equal(timeoutOf("30000"), undefined);
    assert.equal(timeoutOf(Number.NaN), undefined);
    assert.equal(timeoutOf(Number.POSITIVE_INFINITY), undefined);
    assert.equal(parseDesktopCommand(valid)?.timeoutMs, undefined);
  });

  test("keeps asFiniteInteger unclamped, because sequence 0 is a real value", () => {
    // Load-bearing: `asFiniteInteger` is shared with `event.sequence` on the
    // command-event ack, where 0 means "nothing acked yet" — `lastSequenceAcked`
    // is `@default(0)` in the schema and the executor starts its own counter at
    // 0. Moving the timeout clamp INTO this helper would floor that ack to 1,
    // mark the first event acked, and drop it from replay forever. The clamp
    // belongs on the timeoutMs field, not here.
    assert.equal(asFiniteInteger(0), 0);
    assert.equal(asFiniteInteger(2_147_483_648), 2_147_483_648);
  });
});

/**
 * ISS-8565: both coercers built their result on a plain `{}`, so a key literally
 * named `__proto__` — which `JSON.parse` DOES deliver as a real own key off the
 * cloud socket — hit the inherited setter and vanished from the record.
 *
 * Fixtures use `Object.create(null)`: a quoted `"__proto__"` in an object
 * LITERAL is the prototype-setter form and creates no own key, so a literal
 * fixture would drop the key before the coercer ever saw it.
 */
describe("cloud socket coercers keep a __proto__ key (ISS-8565)", () => {
  test("asStringRecord keeps it as an own key", () => {
    const input: Record<string, unknown> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    input.__proto__ = "sentinel";
    input["x-normal"] = "kept";

    const out = asStringRecord(input);

    assert.ok(out);
    assert.deepEqual(Object.keys(out).sort(), ["__proto__", "x-normal"]);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.equal(out.__proto__, "sentinel");
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });

  test("asQueryRecord keeps it on BOTH the string and the array sink", () => {
    const input: Record<string, unknown> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    input.__proto__ = "scalar";
    input.normal = ["a", "b"];

    const out = asQueryRecord(input);

    assert.ok(out);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.equal(out.__proto__, "scalar");
    assert.deepEqual(out.normal, ["a", "b"]);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);

    const arrayKeyed: Record<string, unknown> = Object.create(null);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    arrayKeyed.__proto__ = ["one", "two"];
    const arrayOut = asQueryRecord(arrayKeyed);
    assert.ok(arrayOut);
    // biome-ignore lint/suspicious/noProto: ISS-8565 regression — the hostile key IS the subject under test
    assert.deepEqual(arrayOut.__proto__, ["one", "two"]);
  });

  test("an ordinary record still coerces byte-identically", () => {
    assert.equal(
      JSON.stringify(asStringRecord({ b: "2", a: "1" })),
      '{"b":"2","a":"1"}'
    );
  });
});
