/**
 * ISS-5723 — the Electron E2E suite ran at `workers: 1` because two concurrent
 * app instances collide on the two FIXED loopback listeners: the agent hook
 * listener (`AGENT_MONITOR_PORT`, 4820) and the OTLP receiver
 * (`DEFAULT_OTLP_RECEIVER_PORT`, 4318).
 *
 * The collision is the dangerous kind: both listeners fail SOFT on `EADDRINUSE`,
 * so the losing instance does not crash — it comes up with agent capture off and
 * everything else working. Raising the worker count without isolating them would
 * have produced a coin flip over which worker's app won each bind, surfacing as
 * intermittent spec failures that look like product bugs.
 *
 * So these tests assert the ISOLATION, not the worker count: for each listener,
 * two instances started concurrently against the same resolved port must BOTH
 * come up, on DIFFERENT ports. The paired "fixed port" case is the counterfactual
 * — it pins the exact soft failure the isolation removes, and it is what fails if
 * someone later drops the argument from the launch path.
 *
 * The real 4820/4318 are never bound here: doing so would fail the suite whenever
 * an operator happens to have the desktop app running, which is precisely the
 * class of flake this ticket is about. Where a port must actually be OWNED, the
 * first listener binds an ephemeral one and keeps it (see `boundPortOf`); where
 * only a number is needed, `UNBOUND_PORT_STAND_IN` is used and nothing listens.
 */

import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript6";
import type { AgentHookLifecycle } from "../src/main/agent-monitor/agent-monitor-listener.js";
import { AgentHookListener } from "../src/main/agent-monitor/agent-monitor-listener.js";
import {
  E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
  resolveLoopbackListenerPort,
} from "../src/main/lifecycle/loopback-port-isolation.js";
import { OtlpHttpReceiver } from "../src/main/telemetry/otlp-http-receiver.js";
import { e2eAppLaunchArgs } from "./e2e/helpers/desktop-app.js";
import { forEachNode, parseTypeScriptFile } from "./helpers/ts-ast.js";

/** `apps/desktop`, so the wiring assertions name repo paths rather than `../..`. */
const DESKTOP_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const COMPOSITION_ROOT_SOURCE =
  "src/main/dashboard/agent-dashboard-design-system-runtime.ts";
const LAUNCHER_SOURCES = [
  "test/e2e/helpers/desktop-app.ts",
  "test/e2e/helpers/branch-details-authenticated-cloud.ts",
];
/** The composition root's local wrapper around `resolveLoopbackListenerPort`. */
const LOOPBACK_PORT_HELPER = "loopbackPort";

function parseDesktopFile(relativePath: string): ts.SourceFile {
  return parseTypeScriptFile(path.join(DESKTOP_ROOT, relativePath));
}

/** True when `source` calls `name(...)` anywhere. */
function callsIdentifier(source: ts.SourceFile, name: string): boolean {
  let found = false;
  forEachNode(source, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === name
    ) {
      found = true;
    }
  });
  return found;
}

/**
 * The callee of the `port:` property in `new <className>({ ... })`, or null.
 *
 * Returns the CALLEE rather than a boolean so a literal port reads as `null` and
 * fails with the value it found, instead of a bare "expected true".
 */
function portArgumentCallee(
  source: ts.SourceFile,
  className: string
): string | null {
  let callee: string | null = null;
  forEachNode(source, (node) => {
    if (
      !(
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === className
      )
    ) {
      return;
    }
    const [options] = node.arguments ?? [];
    if (!(options && ts.isObjectLiteralExpression(options))) {
      return;
    }
    for (const property of options.properties) {
      if (
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "port" &&
        ts.isCallExpression(property.initializer) &&
        ts.isIdentifier(property.initializer.expression)
      ) {
        callee = property.initializer.expression.text;
      }
    }
  });
  return callee;
}

/** A lifecycle that records nothing — these tests never post a hook payload. */
const INERT_LIFECYCLE: AgentHookLifecycle = {
  processEvent: () => false,
};

/** The listener's own fail-soft `EADDRINUSE` wording. */
const IN_USE_REASON = /already in use/;

/**
 * An arbitrary port NUMBER, for the cases that never bind it.
 *
 * `resolveLoopbackListenerPort` is a pure function; the isolated-path tests
 * discard this (it resolves to 0) and the packaged test only checks it comes
 * back unchanged. Nothing listens on it, so it does not have to be free — and
 * probing for a free one would be the same reserve-then-release race the
 * colliding tests below deliberately avoid.
 */
const UNBOUND_PORT_STAND_IN = 4820;

/**
 * The port a started listener actually bound.
 *
 * The colliding tests need a port something already OWNS. Reserving one by
 * binding and releasing left a window in which another node:test worker could
 * take it (wongk, PR #4923) — in a suite about port determinism, that is the
 * exact flake being fixed. So the first listener binds port 0 and KEEPS it, and
 * the collider races that live owner rather than a recently-vacated number.
 * Nothing is ever unowned between the read and the collision.
 */
function boundPortOf(url: string | null): number {
  if (!url) {
    throw new Error("listener reported no URL — it never bound");
  }
  const { port } = new URL(url);
  const parsed = Number(port);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`listener URL carries no usable port: ${url}`);
  }
  return parsed;
}

test("ISS-5723: two hook listeners on the ISOLATED port both bind, on different ports", async () => {
  const fixedPort = UNBOUND_PORT_STAND_IN;
  const port = resolveLoopbackListenerPort(
    fixedPort,
    [E2E_EPHEMERAL_LOOPBACK_PORTS_ARG],
    { isPackaged: false }
  );

  const first = new AgentHookListener({ lifecycle: INERT_LIFECYCLE, port });
  const second = new AgentHookListener({ lifecycle: INERT_LIFECYCLE, port });
  try {
    await Promise.all([first.start(), second.start()]);

    // A ready listener reports the address it actually bound, so two distinct
    // loopback URLs is the direct evidence that they did not contend.
    assert.equal(first.isReady(), true);
    assert.equal(second.isReady(), true);
    assert.notEqual(first.getUrl(), second.getUrl());
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("ISS-5723: on a FIXED port the second hook listener silently loses the bind", async () => {
  // The counterfactual. `resolveLoopbackListenerPort` hands back the real port
  // when the launch did not opt out, and the second instance then reports
  // `isReady() === false` WITHOUT throwing — the soft failure that would have
  // turned any capture-asserting spec into a coin flip at `workers: 2`.
  let bindError: string | null = null;
  // The owner binds an ephemeral port and holds it; its live port is what the
  // collider races. See boundPortOf for why this is not reserve-then-release.
  const first = new AgentHookListener({ lifecycle: INERT_LIFECYCLE, port: 0 });
  let collider: AgentHookListener | undefined;
  try {
    await first.start();
    assert.equal(first.isReady(), true);

    const fixedPort = boundPortOf(first.getUrl());
    const port = resolveLoopbackListenerPort(fixedPort, [], {
      isPackaged: false,
    });
    assert.equal(port, fixedPort);

    collider = new AgentHookListener({
      lifecycle: INERT_LIFECYCLE,
      onBindError: (reason) => {
        bindError = reason;
      },
      port,
    });
    await collider.start();

    assert.equal(first.isReady(), true);
    assert.equal(collider.isReady(), false);
    assert.match(String(bindError), IN_USE_REASON);
  } finally {
    await Promise.all([first.stop(), collider?.stop()]);
  }
});

test("ISS-5723: two OTLP receivers on the ISOLATED port both bind, on different ports", async () => {
  const fixedPort = UNBOUND_PORT_STAND_IN;
  const port = resolveLoopbackListenerPort(
    fixedPort,
    [E2E_EPHEMERAL_LOOPBACK_PORTS_ARG],
    { isPackaged: false }
  );

  const first = new OtlpHttpReceiver({ port });
  const second = new OtlpHttpReceiver({ port });
  try {
    const [firstState, secondState] = await Promise.all([
      first.start(),
      second.start(),
    ]);

    assert.equal(firstState.available, true);
    assert.equal(secondState.available, true);
    assert.notEqual(firstState.port, secondState.port);
  } finally {
    await Promise.all([first.stop(), second.stop()]);
  }
});

test("ISS-5723: on a FIXED port the second OTLP receiver reports unavailable", async () => {
  // Same live-owner shape as the hook-listener collision above.
  const first = new OtlpHttpReceiver({ port: 0 });
  let collider: OtlpHttpReceiver | undefined;
  try {
    const firstState = await first.start();
    assert.equal(firstState.available, true);

    const bound = first.getBoundAddress();
    assert.ok(bound, "the first receiver reported no bound address");
    const port = resolveLoopbackListenerPort(bound.port, [], {
      isPackaged: false,
    });
    assert.equal(port, bound.port);

    collider = new OtlpHttpReceiver({ port });
    const colliderState = await collider.start();

    assert.equal(colliderState.available, false);
  } finally {
    await Promise.all([first.stop(), collider?.stop()]);
  }
});

test("ISS-5723: a PACKAGED build keeps its fixed port even when handed the argument", () => {
  // The hook commands in a real `~/.claude/settings.json` post to a hardcoded
  // port, so an installed app must never honor this — not even if the argument
  // is inherited or passed by hand.
  const fixedPort = UNBOUND_PORT_STAND_IN;

  assert.equal(
    resolveLoopbackListenerPort(fixedPort, [E2E_EPHEMERAL_LOOPBACK_PORTS_ARG], {
      isPackaged: true,
    }),
    fixedPort
  );
});

test("ISS-5723: every E2E launch carries the ephemeral-loopback argument", () => {
  assert.ok(e2eAppLaunchArgs(false).includes(E2E_EPHEMERAL_LOOPBACK_PORTS_ARG));
  assert.ok(e2eAppLaunchArgs(true).includes(E2E_EPHEMERAL_LOOPBACK_PORTS_ARG));
});

// The assertion above only proves the HELPER returns the flag (wongk, PR #4923).
// Deleting its use from either launcher, or dropping either production port
// injection, leaves it green while the isolation stops happening — the whole
// mechanism reverts and every test in this file still passes. These two close
// that, structurally, at the two ends the helper cannot speak for.
//
// AST, not a text scan: `no-raw-text-source-scan` bans asserting on TypeScript
// source as raw text, and a regex would match the identifier in a comment.
test("ISS-5723: both E2E launchers build their args from the shared helper", () => {
  for (const launcher of LAUNCHER_SOURCES) {
    assert.ok(
      callsIdentifier(parseDesktopFile(launcher), "e2eAppLaunchArgs"),
      `${launcher} must build its launch args from e2eAppLaunchArgs — an app launched without the argument silently takes the fixed ports`
    );
  }
});

test("ISS-5723: the composition root resolves BOTH loopback ports", () => {
  // Not "resolveLoopbackListenerPort appears somewhere": each listener's own
  // `port:` must be the resolved value. Dropping one injection leaves the other
  // isolated and this red, which is the asymmetry a presence check would miss.
  const root = parseDesktopFile(COMPOSITION_ROOT_SOURCE);

  assert.ok(
    callsIdentifier(root, "resolveLoopbackListenerPort"),
    `${COMPOSITION_ROOT_SOURCE} must resolve the loopback ports — it is the only place that can read app.isPackaged`
  );
  for (const listener of ["OtlpHttpReceiver", "AgentHookListener"]) {
    assert.equal(
      portArgumentCallee(root, listener),
      LOOPBACK_PORT_HELPER,
      `${listener} must be constructed with a ${LOOPBACK_PORT_HELPER}(...) port in ${COMPOSITION_ROOT_SOURCE}; a literal or default port puts this listener back on the fixed port while the other stays isolated`
    );
  }
});
