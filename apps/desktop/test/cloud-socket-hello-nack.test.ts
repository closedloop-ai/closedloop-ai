import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { DesktopHelloNackReason } from "@repo/api/src/types/compute-target";
import ts from "typescript6";
import {
  HELLO_NACK_MESSAGES,
  UNRECOGNIZED_HELLO_NACK_MESSAGE,
} from "../src/main/cloud/cloud-hello-nack.js";
import type { CloudSocketStatus } from "../src/main/cloud/cloud-protocol.js";
import { CloudSocketService } from "../src/main/cloud/cloud-socket.js";
import { gatewayLog } from "../src/main/logging/gateway-logger.js";
import {
  createStubOptions,
  FakeSocket,
} from "./helpers/cloud-socket-fixtures.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";
import { nodeTestTimers } from "./support/node-test-fake-timers.js";

// ---------------------------------------------------------------------------
// ISS-6126: the cloud emits `desktop.hello.nack` with a typed reason and only
// then disconnects. Before this suite the desktop had no handler at all, so
// every distinct rejection collapsed into Socket.IO's own generic string:
//
//   Cloud socket disconnected: io server disconnect
//
// These tests assert WHAT THE USER SEES (`CloudSocketStatus.error`) for each
// reason, for an unrecognized reason, and for a server disconnect that carries
// no nack. Asserting that a handler is registered would pass on code that
// swallows the reason, which is the exact bug.
// ---------------------------------------------------------------------------

const SERVER_DISCONNECT = "io server disconnect";
const PAUSE_NOTICE = "Paused for 60s before the next attempt.";

type Harness = {
  service: CloudSocketService;
  socket: FakeSocket;
  statuses: CloudSocketStatus[];
};

/** Private-method access, matching the existing cloud-socket test convention. */
function protoOf(
  service: CloudSocketService
): Record<string, (...args: unknown[]) => unknown> {
  return Object.getPrototypeOf(service);
}

/**
 * Builds a service whose real socket handlers are bound to a fake socket, in
 * the state the connect handler leaves behind: hello emitted, ack outstanding.
 */
function armServiceAfterHello(): Harness {
  const statuses: CloudSocketStatus[] = [];
  const service = new CloudSocketService(
    createStubOptions({ onStatusChange: (status) => statuses.push(status) })
  );
  const socket = new FakeSocket();
  const internals = service as unknown as Record<string, unknown>;
  internals.socket = socket;
  internals.stopped = false;
  internals.awaitingHelloAck = true;
  protoOf(service).registerSocketHandlers.call(service, socket);
  return { service, socket, statuses };
}

/** Re-arms an outstanding handshake without going through a socket recycle. */
function rearmHandshake(service: CloudSocketService): void {
  (service as unknown as Record<string, unknown>).awaitingHelloAck = true;
}

/**
 * What the user would be shown right now. Returns a readable sentinel rather
 * than throwing when nothing was surfaced at all, so a regression reports "the
 * reason never reached the user" instead of an opaque undefined.
 */
function latestError(statuses: CloudSocketStatus[]): string {
  const last = statuses.at(-1);
  if (last?.state !== "degraded") {
    return NO_SURFACED_ERROR;
  }
  return last.error;
}

/** The most recent `Hello rejected by cloud:` diagnostic, if any. */
function latestRejectionLog(): string | undefined {
  return gatewayLog
    .getEntries()
    .filter(
      (entry) =>
        entry.tag === "cloud-socket" &&
        entry.message.startsWith("Hello rejected by cloud:")
    )
    .at(-1)?.message;
}

const NO_SURFACED_ERROR = "(nothing was surfaced to the user)";
const UNRECOGNIZED_LOG_RE = /reason=\(unrecognized\), recognized=false/;
const UNRECOGNIZED_LOG_LENGTH_RE = /reasonLength=25/;
const ABSENT_LOG_RE = /reason=\(absent\), recognized=false, reasonLength=0/;
const OVERSIZED_LOG_LENGTH_RE = /reasonLength=5000/;

afterEach(() => {
  nodeTestTimers.reset();
  gatewayLog.clear();
});

// ---------------------------------------------------------------------------
// AC1: each of the five reasons produces a distinct, actionable message
// ---------------------------------------------------------------------------

const REASON_MESSAGES: ReadonlyArray<
  readonly [DesktopHelloNackReason, string]
> = [
  [
    DesktopHelloNackReason.ComputeTargetRegisterFailed,
    "Cloud could not register this machine (compute_target_register_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  ],
  [
    DesktopHelloNackReason.ComputeTargetUpdateFailed,
    "Cloud could not update this machine's registration (compute_target_update_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  ],
  [
    DesktopHelloNackReason.OnlineStateUpdateFailed,
    "Cloud could not mark this machine online (online_state_update_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  ],
  [
    DesktopHelloNackReason.PendingCommandsLookupFailed,
    "Cloud could not load this machine's pending commands (pending_commands_lookup_failed). Reconnecting — if this keeps happening, check ClosedLoop status.",
  ],
  [
    DesktopHelloNackReason.InternalError,
    "Cloud hit an internal error while accepting this machine (internal_error). Reconnecting — if this keeps happening, check ClosedLoop status.",
  ],
];

describe("ISS-6126: desktop.hello.nack reaches the user", () => {
  for (const [reason, expected] of REASON_MESSAGES) {
    test(`${reason} surfaces its own message, and the disconnect that follows does not overwrite it`, () => {
      const { service, socket, statuses } = armServiceAfterHello();

      socket.emit("desktop.hello.nack", { reason });
      assert.equal(
        latestError(statuses),
        expected,
        "the nack reason must be what the user reads"
      );

      // The cloud disconnects immediately after the nack. Without the
      // rejection being carried through, this is the frame that reintroduced
      // "Cloud socket disconnected: io server disconnect".
      socket.emit("disconnect", SERVER_DISCONNECT);
      assert.equal(
        latestError(statuses),
        expected,
        "the disconnect must not replace the reason with the generic string"
      );
      assert.ok(
        !latestError(statuses).includes(SERVER_DISCONNECT),
        "the Socket.IO string must not be the user-facing cause"
      );

      const logged = latestRejectionLog();
      assert.ok(logged, "the rejection must produce a diagnostic log line");
      assert.match(logged, new RegExp(`reason=${reason}, recognized=true`));

      service.stop();
    });
  }

  test("the SHIPPED message table gives every reason its own message", () => {
    const shipped = Object.values(HELLO_NACK_MESSAGES);
    assert.equal(
      new Set(shipped).size,
      shipped.length,
      "two reasons sharing a message would put the user back where ISS-6126 started"
    );
  });

  test("every DesktopHelloNackReason member is exercised above", () => {
    // Canary: a sixth reason compiles once cloud-hello-nack.ts gives it a
    // message, and would otherwise ship with no coverage in this file.
    assert.deepEqual(
      REASON_MESSAGES.map(([reason]) => reason).sort(),
      Object.values(DesktopHelloNackReason).sort()
    );
  });
});

// ---------------------------------------------------------------------------
// AC4: cross-repo skew — unknown, absent, and malformed reasons
//
// Nothing from the wire is ever echoed. The reason crosses an untrusted,
// version-skewed boundary and lands in the status bar, the raw console sink and
// persistent diagnostics; a length cap does not make CR/LF or terminal control
// bytes safe there, so the only strings that reach those sinks are ones this
// build authored, plus bounded non-content metadata (the reason's length).
// ---------------------------------------------------------------------------

describe("ISS-6126: version-skewed nack payloads degrade instead of throwing", () => {
  test("an unrecognized reason from a newer cloud renders generically and is never echoed", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("desktop.hello.nack", {
      reason: "quota_exhausted\r\nINJECTED",
    });

    assert.equal(latestError(statuses), UNRECOGNIZED_HELLO_NACK_MESSAGE);
    assert.ok(
      !latestError(statuses).includes("INJECTED"),
      "wire content must not reach the status bar"
    );
    const logged = latestRejectionLog();
    assert.ok(logged);
    assert.ok(
      !logged.includes("INJECTED"),
      "wire content must not reach the gateway log either"
    );
    assert.match(logged, UNRECOGNIZED_LOG_RE);
    assert.match(logged, UNRECOGNIZED_LOG_LENGTH_RE);
    service.stop();
  });

  for (const [label, payload] of [
    ["an empty object", {}],
    ["a null payload", null],
    ["a non-string reason", { reason: 42 }],
    ["a blank reason", { reason: "   " }],
  ] as const) {
    test(`${label} is surfaced as an unrecognized rejection rather than throwing`, () => {
      const { service, socket, statuses } = armServiceAfterHello();

      assert.doesNotThrow(() => {
        socket.emit("desktop.hello.nack", payload);
      });
      assert.equal(latestError(statuses), UNRECOGNIZED_HELLO_NACK_MESSAGE);
      const logged = latestRejectionLog();
      assert.ok(logged);
      assert.match(logged, ABSENT_LOG_RE);
      service.stop();
    });
  }

  // A plain-object lookup keyed by an untrusted wire string resolves
  // `"constructor"` / `"toString"` up the prototype chain to a truthy value
  // that is not a message, which would report the rejection as RECOGNIZED and
  // surface a literal `undefined` to the user.
  for (const inherited of [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ]) {
    test(`a reason named "${inherited}" is unrecognized, not an inherited Object member`, () => {
      const { service, socket, statuses } = armServiceAfterHello();

      socket.emit("desktop.hello.nack", { reason: inherited });

      assert.equal(latestError(statuses), UNRECOGNIZED_HELLO_NACK_MESSAGE);
      assert.ok(
        !latestError(statuses).includes("undefined"),
        "an inherited member must never be rendered as a message"
      );
      service.stop();
    });
  }

  test("an oversized reason cannot choose how much text the desktop renders or logs", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("desktop.hello.nack", { reason: "z".repeat(5000) });

    const shown = latestError(statuses);
    assert.equal(shown, UNRECOGNIZED_HELLO_NACK_MESSAGE);
    assert.ok(!shown.includes("zzz"), "the blob must not be echoed at all");
    const logged = latestRejectionLog();
    assert.ok(logged);
    assert.ok(!logged.includes("zzz"), "nor written to the gateway log");
    assert.match(
      logged,
      OVERSIZED_LOG_LENGTH_RE,
      "the length is the bounded non-content metadata a support log keeps"
    );
    service.stop();
  });
});

// ---------------------------------------------------------------------------
// AC2: a server disconnect WITHOUT a nack is distinguishable
// ---------------------------------------------------------------------------

describe("ISS-6126: a hello rejected without a reason", () => {
  test("a server-initiated close after hello, with no nack, says so distinctly", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("disconnect", SERVER_DISCONNECT);

    assert.equal(
      latestError(statuses),
      "Cloud closed the connection during the handshake without saying why. Reconnecting — if this keeps happening, another machine may be registered with the same gateway ID."
    );
    const logged = gatewayLog
      .getEntries()
      .find(
        (entry) =>
          entry.tag === "cloud-socket" &&
          entry.message.includes("without sending desktop.hello.nack")
      );
    assert.ok(logged, "the silent rejection must be logged distinctly");
    service.stop();
  });

  test("an ordinary transport drop while awaiting the ack keeps the legacy message", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("disconnect", "transport close");

    assert.equal(
      latestError(statuses),
      "Cloud socket disconnected: transport close",
      "a network drop is not a rejection and must not claim to be one"
    );
    service.stop();
  });

  test("a server close with no hello outstanding keeps the legacy message", () => {
    const { service, socket, statuses } = armServiceAfterHello();
    (service as unknown as Record<string, unknown>).awaitingHelloAck = false;

    socket.emit("disconnect", SERVER_DISCONNECT);

    assert.equal(
      latestError(statuses),
      `Cloud socket disconnected: ${SERVER_DISCONNECT}`
    );
    service.stop();
  });
});

// ---------------------------------------------------------------------------
// Scope item 4: do not retry blindly into a nack loop, and do not over-correct.
//
// The back-off is streak-based and reason-blind. Every reason the cloud can
// send is also what a 5s stage deadline produces (`runStage` in
// apps/api/lib/with-timeout.ts is called with no distinct `failureReason`), so
// the wire cannot tell a transient slowdown from a permanent failure. Reading
// retryability out of the reason would either punish a blip with a minute of
// silence or let an unrecognized reason hammer `desktop.hello` forever.
// ---------------------------------------------------------------------------

describe("ISS-6126: a run of rejections backs off, a blip does not", () => {
  test("the first two rejections keep the 1s cadence; the third pauses", async () => {
    nodeTestTimers.enable(["setTimeout"]);
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });
    socket.emit("disconnect", SERVER_DISCONNECT);
    assert.ok(
      !latestError(statuses).includes("Paused for"),
      "a single rejection must still reconnect promptly"
    );
    nodeTestTimers.tick(1000);
    await flushMicrotasks();
    assert.equal(socket.connectCalls, 1, "first retry uses the 1s cadence");

    rearmHandshake(service);
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });
    socket.emit("disconnect", SERVER_DISCONNECT);
    assert.ok(
      !latestError(statuses).includes("Paused for"),
      "two rejections is still inside the transient window"
    );
    nodeTestTimers.tick(1000);
    await flushMicrotasks();
    assert.equal(socket.connectCalls, 2, "second retry uses the 1s cadence");

    rearmHandshake(service);
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });
    assert.equal(
      latestError(statuses),
      `Cloud hit an internal error while accepting this machine (internal_error). Reconnecting — if this keeps happening, check ClosedLoop status. ${PAUSE_NOTICE}`,
      "the third in a row must tell the user the app is pausing, not silently stall"
    );

    socket.emit("disconnect", SERVER_DISCONNECT);
    nodeTestTimers.tick(1000);
    await flushMicrotasks();
    assert.equal(
      socket.connectCalls,
      2,
      "the backed-off retry must NOT fire at the 1s cadence"
    );

    nodeTestTimers.tick(59_000);
    await flushMicrotasks();
    assert.equal(
      socket.connectCalls,
      3,
      "the backed-off retry must still fire, so the desktop self-heals"
    );

    service.stop();
  });

  // Regression for the review finding on this PR: `compute_target_register_failed`
  // is what `runStage` emits when `computeTargetsService.register` blows its 5s
  // deadline, with no distinct failure reason. Treating it as permanent turned a
  // transient cloud slowdown into a 60s stall on the second attempt.
  test("two consecutive registration failures still recover at the fast cadence", async () => {
    nodeTestTimers.enable(["setTimeout"]);
    const { service, socket, statuses } = armServiceAfterHello();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      rearmHandshake(service);
      socket.emit("desktop.hello.nack", {
        reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
      });
      socket.emit("disconnect", SERVER_DISCONNECT);
      nodeTestTimers.tick(1000);
      await flushMicrotasks();
    }

    assert.equal(
      socket.connectCalls,
      2,
      "a timeout-capable reason must not be punished on its second occurrence"
    );
    assert.ok(
      !latestError(statuses).includes("Paused for"),
      "a two-attempt slowdown must not claim the app has paused"
    );
    service.stop();
  });

  // Regression for the review finding on this PR: an unrecognized reason used to
  // be treated as permanently retryable, so a newer cloud's permanent rejection
  // made an older desktop hammer `desktop.hello` once a second until upgraded.
  test("a run of unrecognized reasons is bounded by the same back-off", async () => {
    nodeTestTimers.enable(["setTimeout"]);
    const { service, socket, statuses } = armServiceAfterHello();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      rearmHandshake(service);
      socket.emit("desktop.hello.nack", { reason: "quota_exhausted" });
      socket.emit("disconnect", SERVER_DISCONNECT);
      nodeTestTimers.tick(1000);
      await flushMicrotasks();
    }

    assert.equal(
      socket.connectCalls,
      2,
      "the third unrecognized rejection must stop the 1s hammering"
    );
    assert.equal(
      latestError(statuses),
      `${UNRECOGNIZED_HELLO_NACK_MESSAGE} ${PAUSE_NOTICE}`
    );

    nodeTestTimers.tick(60_000);
    await flushMicrotasks();
    assert.equal(
      socket.connectCalls,
      3,
      "bounded, not abandoned: an unrecognized reason still retries eventually"
    );
    service.stop();
  });

  test("an outage that alternates reasons still backs off", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.ComputeTargetRegisterFailed,
    });
    rearmHandshake(service);
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.OnlineStateUpdateFailed,
    });
    rearmHandshake(service);
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });

    assert.ok(
      latestError(statuses).includes("Paused for 60s"),
      "keying the back-off on reason identity would let a shifting outage flap forever"
    );
    service.stop();
  });

  test("the streak survives the real connect handler, so the back-off is reachable in production", () => {
    // Fake timers so the hello-ack supervision each real `connect` arms does not
    // hold the process open after the assertions are done.
    nodeTestTimers.enable(["setTimeout"]);
    const { service, socket, statuses } = armServiceAfterHello();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      socket.emit("desktop.hello.nack", {
        reason: DesktopHelloNackReason.InternalError,
      });
      socket.emit("disconnect", SERVER_DISCONNECT);
      // Drive the PRODUCTION `connect` handler instead of hand-setting
      // `awaitingHelloAck`. That handler is the only place deciding what a fresh
      // socket forgets, and the flap being counted spans sockets. If it were
      // "simplified" to call clearHelloRejectionState(), the streak would reset
      // here and the back-off could never fire in production — with every other
      // test in this file still green.
      socket.emit("connect");
    }
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });

    assert.ok(
      latestError(statuses).includes("Paused for 60s"),
      "a reconnect must not amnesty the streak that the reconnect itself is part of"
    );
    service.stop();
  });

  test("the 60s pause is consumed once and does not leak into a later unrelated drop", async () => {
    nodeTestTimers.enable(["setTimeout"]);
    const { service, socket } = armServiceAfterHello();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      rearmHandshake(service);
      socket.emit("desktop.hello.nack", {
        reason: DesktopHelloNackReason.InternalError,
      });
    }
    socket.emit("disconnect", SERVER_DISCONNECT);
    nodeTestTimers.tick(60_000);
    await flushMicrotasks();
    assert.equal(socket.connectCalls, 1, "the backed-off retry fires at 60s");

    // A later ordinary drop must reconnect at the normal cadence: the pause was
    // a one-shot for that rejection, not a new baseline.
    socket.emit("connect");
    socket.emit("desktop.hello.ack", {
      computeTargetId: "target-1",
      sessionId: "session-1",
      serverTime: new Date().toISOString(),
    });
    socket.emit("disconnect", "transport close");
    nodeTestTimers.tick(1000);
    await flushMicrotasks();

    assert.equal(
      socket.connectCalls,
      2,
      "a stale 60s delay must not be reused for an unrelated network drop"
    );
    service.stop();
  });

  test("a nack with no handshake in flight is ignored rather than degrading a live socket", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    socket.emit("desktop.hello.ack", {
      computeTargetId: "target-1",
      sessionId: "session-1",
      serverTime: new Date().toISOString(),
    });
    const onlineStatus = statuses.at(-1);
    assert.equal(onlineStatus?.state, "online");

    // A late, duplicated, or reordered nack about the already-settled hello.
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });

    assert.equal(
      statuses.at(-1)?.state,
      "online",
      "a stale nack must not knock a healthy connection back to degraded"
    );
    service.stop();
  });

  test("a successful hello ack clears the rejection AND the streak", () => {
    const { service, socket, statuses } = armServiceAfterHello();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      rearmHandshake(service);
      socket.emit("desktop.hello.nack", {
        reason: DesktopHelloNackReason.InternalError,
      });
    }
    socket.emit("desktop.hello.ack", {
      computeTargetId: "target-1",
      sessionId: "session-1",
      serverTime: new Date().toISOString(),
    });
    socket.emit("disconnect", "transport close");

    assert.equal(
      latestError(statuses),
      "Cloud socket disconnected: transport close",
      "a stale rejection must not outlive a successful handshake"
    );

    // The streak must have restarted too. If only the message half of
    // clearHelloRejectionState() survived a future edit, this next nack would
    // read as the third of a run and back off immediately.
    rearmHandshake(service);
    socket.emit("desktop.hello.nack", {
      reason: DesktopHelloNackReason.InternalError,
    });
    assert.ok(
      !latestError(statuses).includes("Paused for"),
      "a successful handshake must reset the consecutive-rejection count"
    );
    service.stop();
  });
});

// ---------------------------------------------------------------------------
// Production wiring: the behavioural tests above drive `registerSocketHandlers`
// directly, so they would stay green if `connect()` stopped calling it. This is
// the structural invariant that closes that gap — asserted on the resolved AST,
// never on raw source text.
// ---------------------------------------------------------------------------

describe("ISS-6126: connect() installs the socket handlers", () => {
  test("connect() calls registerSocketHandlers", () => {
    const sourcePath = fileURLToPath(
      new URL("../src/main/cloud/cloud-socket.ts", import.meta.url)
    );
    const sourceFile = parseTypeScriptFile(sourcePath);

    let connectBody: ts.Node | undefined;
    forEachNode(sourceFile, (node) => {
      if (
        ts.isMethodDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "connect" &&
        node.body
      ) {
        connectBody = node.body;
      }
    });
    assert.ok(connectBody, "CloudSocketService must declare connect()");

    let registers = false;
    forEachNode(connectBody, (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        node.expression.name.text === "registerSocketHandlers"
      ) {
        registers = true;
      }
    });
    assert.ok(
      registers,
      "connect() must call this.registerSocketHandlers(socket), or no live socket ever gets the desktop.hello.nack listener"
    );
  });
});

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}
