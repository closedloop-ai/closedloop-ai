import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";
import {
  classifyDeepLink,
  classifyInitialDeepLink,
  createDeepLinkListeners,
  DeepLinkRejection,
  findDeepLinkInArgv,
  handleDeepLinkActivation,
  isAllowedDeepLink,
  registerDeepLinkProtocolClient,
  reportInitialDeepLink,
  resolveProtocolClientRegistration,
  shouldRegisterProtocolClient,
} from "../src/main/lifecycle/deep-link.js";

/**
 * ISS-6109. A registered protocol handler is a remotely reachable entry point:
 * any web page can navigate a user to `closedloop://<anything>`, and the OS
 * hands that string to this process. These tests drive the real handler with the
 * payloads an attacker controls and assert the effect — that an accepted link
 * activates the app and a refused one does nothing at all.
 */

const RE_UNEXPECTED_PAYLOAD = /unexpected-payload/;
const RE_ACTIVATION_ERROR = /window gone/;
const RE_UNPACKAGED_MACOS = /unpackaged macOS/;
const RE_REFUSED = /refused/;
const RE_SESSION_BUS_ERROR = /no session bus/;
const RE_EVIL_HOST = /evil\.example/;
const RE_LAUNCHED_BY_DEEP_LINK = /this boot serves it/;

type ActivationRun = {
  activateCalls: number;
  logs: string[];
};

async function runActivation(
  url: string,
  options: { activateRejects?: Error } = {}
): Promise<ActivationRun> {
  const run: ActivationRun = { activateCalls: 0, logs: [] };
  await handleDeepLinkActivation({
    activate: () => {
      run.activateCalls += 1;
      return options.activateRejects
        ? Promise.reject(options.activateRejects)
        : Promise.resolve();
    },
    log: (message) => run.logs.push(message),
    url,
  });
  return run;
}

describe("deep-link URL policy", () => {
  test("accepts the bare payload-free launch URL", () => {
    assert.equal(classifyDeepLink(DESKTOP_DEEP_LINK_URL), null);
    assert.equal(isAllowedDeepLink(DESKTOP_DEEP_LINK_URL), true);
  });

  test("accepts the scheme-only spelling some launchers deliver", () => {
    assert.equal(isAllowedDeepLink("closedloop:"), true);
  });

  test("accepts an upper-case scheme (the OS does not normalize it)", () => {
    assert.equal(isAllowedDeepLink("CLOSEDLOOP://"), true);
  });

  test("accepts the three-slash spelling, which carries no payload either", () => {
    // `closedloop:///` normalizes to pathname "/" and zero bytes of data.
    // Refusing it would be indistinguishable from an unregistered scheme (a
    // refusal is deliberately silent), so a launcher that hands back this
    // spelling would make the feature look dead and make the web fallback tell
    // a current build it is out of date.
    assert.equal(classifyDeepLink("closedloop:///"), null);
    assert.equal(isAllowedDeepLink("closedloop:///"), true);
  });

  test("accepts a bare ? or # the URL parser normalizes away", () => {
    assert.equal(isAllowedDeepLink("closedloop://?"), true);
    assert.equal(isAllowedDeepLink("closedloop://#"), true);
  });

  test("still refuses a path with actual bytes in it", () => {
    // The `/` relaxation above must widen the policy by zero bytes.
    for (const url of [
      "closedloop:///etc/passwd",
      "closedloop:///a",
      "closedloop:////",
    ]) {
      assert.equal(
        classifyDeepLink(url),
        DeepLinkRejection.UnexpectedPayload,
        url
      );
    }
  });

  test("refuses a payload the URL parser would normalize away", () => {
    // `new URL` percent-decodes and collapses dot segments before `pathname` is
    // read, so every one of these lands on "/" and a parsed-only policy accepts
    // it. Payload-free has to hold for the spelling the OS actually delivered.
    for (const url of [
      "closedloop:///%2e",
      "closedloop:///%2e%2e",
      "closedloop:///.",
      "closedloop:///..",
      "closedloop:///%2E%2E",
    ]) {
      assert.equal(
        classifyDeepLink(url),
        DeepLinkRejection.UnexpectedPayload,
        url
      );
      assert.equal(isAllowedDeepLink(url), false, url);
    }
  });

  test("refuses every hostile payload shape, by reason", () => {
    const cases: [string, DeepLinkRejection][] = [
      // A host is the shape that would matter most if it ever reached a fetch,
      // a navigation, or openExternal.
      ["closedloop://evil.example/steal", DeepLinkRejection.UnexpectedPayload],
      ["closedloop:///etc/passwd", DeepLinkRejection.UnexpectedPayload],
      [
        "closedloop://?redirect=https://evil.example",
        DeepLinkRejection.UnexpectedPayload,
      ],
      ["closedloop://#../../secret", DeepLinkRejection.UnexpectedPayload],
      [
        "closedloop://user:pw@evil.example/",
        DeepLinkRejection.EmbeddedCredentials,
      ],
      ["https://evil.example/", DeepLinkRejection.ForeignScheme],
      ["file:///etc/passwd", DeepLinkRejection.ForeignScheme],
      ["javascript:alert(1)", DeepLinkRejection.ForeignScheme],
      ["closedloop-evil://", DeepLinkRejection.ForeignScheme],
      ["not a url at all", DeepLinkRejection.Unparseable],
      ["", DeepLinkRejection.Unparseable],
    ];
    for (const [url, expected] of cases) {
      assert.equal(classifyDeepLink(url), expected, `classify ${url}`);
      assert.equal(isAllowedDeepLink(url), false, `allow ${url}`);
    }
  });
});

describe("deep-link activation", () => {
  test("an accepted link activates the app", async () => {
    const run = await runActivation(DESKTOP_DEEP_LINK_URL);
    assert.equal(run.activateCalls, 1);
  });

  test("a hostile link activates NOTHING — not even a window raise", async () => {
    for (const url of [
      "closedloop://evil.example/steal",
      "closedloop://?redirect=https://evil.example",
      "closedloop://user:pw@evil.example/",
      "javascript:alert(1)",
    ]) {
      const run = await runActivation(url);
      assert.equal(run.activateCalls, 0, `must not activate for ${url}`);
    }
  });

  test("the refusal log carries the reason, never the attacker's URL", async () => {
    const hostile = "closedloop://evil.example/steal?token=secret";
    const run = await runActivation(hostile);
    assert.equal(run.logs.length, 1);
    assert.match(run.logs[0], RE_UNEXPECTED_PAYLOAD);
    assert.ok(
      !run.logs[0].includes("evil.example"),
      `log must not echo the payload: ${run.logs[0]}`
    );
    assert.ok(
      !run.logs[0].includes("secret"),
      `log must not echo the payload: ${run.logs[0]}`
    );
  });

  test("an activation failure is logged, not thrown at Electron", async () => {
    const run = await runActivation(DESKTOP_DEEP_LINK_URL, {
      activateRejects: new Error("window gone"),
    });
    assert.equal(run.activateCalls, 1);
    assert.equal(run.logs.length, 1);
    assert.match(run.logs[0], RE_ACTIVATION_ERROR);
  });
});

describe("deep-link argv delivery", () => {
  test("finds the link Windows/Linux append to a second launch", () => {
    assert.equal(
      findDeepLinkInArgv(["C:\\app.exe", "--flag", DESKTOP_DEEP_LINK_URL]),
      DESKTOP_DEEP_LINK_URL
    );
  });

  test("returns null for a plain double-launch so it still focuses", () => {
    assert.equal(findDeepLinkInArgv(["/usr/bin/closedloop", "--flag"]), null);
  });

  test("surfaces a hostile link so the policy can refuse it explicitly", () => {
    // Matching on the scheme prefix alone (rather than pre-validating here) is
    // what keeps a malformed payload from being mistaken for "no link arrived".
    const hostile = "closedloop://evil.example/steal";
    assert.equal(findDeepLinkInArgv(["/usr/bin/closedloop", hostile]), hostile);
    assert.equal(isAllowedDeepLink(hostile), false);
  });
});

describe("deep-link listener wiring", () => {
  type ListenerRun = {
    activateCalls: number;
    preventDefaultCalls: number;
    deepLinkLogs: string[];
    secondInstanceLogs: string[];
  };

  function makeListeners(options: { isReady?: boolean } = {}) {
    const run: ListenerRun = {
      activateCalls: 0,
      deepLinkLogs: [],
      preventDefaultCalls: 0,
      secondInstanceLogs: [],
    };
    const listeners = createDeepLinkListeners({
      activate: () => {
        run.activateCalls += 1;
        return Promise.resolve();
      },
      isReady: () => options.isReady ?? true,
      logDeepLink: (message) => run.deepLinkLogs.push(message),
      logDeepLinkInfo: (message) => run.deepLinkLogs.push(message),
      logSecondInstance: (message) => run.secondInstanceLogs.push(message),
    });
    return { listeners, run };
  }

  function openUrlEvent(run: ListenerRun) {
    return {
      preventDefault: () => {
        run.preventDefaultCalls += 1;
      },
    };
  }

  test("open-url focuses the app for the accepted link", async () => {
    const { listeners, run } = makeListeners();
    await listeners.onOpenUrl(openUrlEvent(run), DESKTOP_DEEP_LINK_URL);
    assert.equal(run.activateCalls, 1);
    assert.equal(run.preventDefaultCalls, 1);
  });

  test("open-url refuses a hostile link without activating", async () => {
    const { listeners, run } = makeListeners();
    await listeners.onOpenUrl(
      openUrlEvent(run),
      "closedloop://evil.example/steal"
    );
    assert.equal(run.activateCalls, 0);
    // Still marked handled: the OS must not fall through to another client.
    assert.equal(run.preventDefaultCalls, 1);
  });

  test("open-url before ready drops the link instead of driving a window", async () => {
    // `handleActivate` builds a BrowserWindow, which Electron cannot create
    // before `ready`; the cold launch this link triggered already serves it.
    const { listeners, run } = makeListeners({ isReady: false });
    await listeners.onOpenUrl(openUrlEvent(run), DESKTOP_DEEP_LINK_URL);
    assert.equal(run.activateCalls, 0);
    assert.equal(run.preventDefaultCalls, 1);
    assert.doesNotMatch(run.deepLinkLogs.join("\n"), RE_REFUSED);
  });

  test("open-url before ready still classifies a hostile link", async () => {
    // The pre-ready branch is the one delivery path with no activation to
    // suppress, which is exactly why it must not become the one path that skips
    // the deny policy and leaves an operator with no record of the refusal.
    const { listeners, run } = makeListeners({ isReady: false });
    await listeners.onOpenUrl(
      openUrlEvent(run),
      "closedloop://evil.example/steal"
    );
    assert.equal(run.activateCalls, 0);
    assert.equal(run.preventDefaultCalls, 1);
    assert.match(run.deepLinkLogs.join("\n"), RE_UNEXPECTED_PAYLOAD);
    // The reason, never the payload.
    assert.doesNotMatch(run.deepLinkLogs.join("\n"), RE_EVIL_HOST);
  });

  test("a plain double-launch still focuses, exactly as before ISS-6109", async () => {
    const { listeners, run } = makeListeners();
    await listeners.onSecondInstance({}, ["/usr/bin/closedloop", "--flag"]);
    assert.equal(run.activateCalls, 1);
  });

  test("second-instance focuses through the SAME activate path, never a new boot", async () => {
    // AC-5: a deep link into a running app must not start a competing db-host.
    // Both argv shapes route to the one injected `activate`, which startup.ts
    // binds to the existing DesktopApplication.
    const { listeners, run } = makeListeners();
    await listeners.onSecondInstance({}, ["/usr/bin/closedloop"]);
    await listeners.onSecondInstance({}, [
      "/usr/bin/closedloop",
      DESKTOP_DEEP_LINK_URL,
    ]);
    assert.equal(run.activateCalls, 2);
  });

  test("second-instance refuses a hostile argv link without activating", async () => {
    const { listeners, run } = makeListeners();
    await listeners.onSecondInstance({}, [
      "/usr/bin/closedloop",
      "closedloop://evil.example/steal",
    ]);
    assert.equal(run.activateCalls, 0);
    assert.match(run.deepLinkLogs.join("\n"), RE_UNEXPECTED_PAYLOAD);
    assert.deepEqual(run.secondInstanceLogs, []);
  });
});

describe("initial (cold-start) deep link", () => {
  function runReport(argv: readonly string[]) {
    const refused: string[] = [];
    const accepted: string[] = [];
    reportInitialDeepLink({
      argv,
      logAccepted: (message) => accepted.push(message),
      logRefused: (message) => refused.push(message),
    });
    return { accepted, refused };
  }

  test("a launch carrying no link classifies nothing", () => {
    assert.equal(
      classifyInitialDeepLink(["/usr/bin/closedloop", "--flag"]),
      null
    );
    const { accepted, refused } = runReport(["/usr/bin/closedloop", "--flag"]);
    assert.deepEqual(accepted, []);
    assert.deepEqual(refused, []);
  });

  test("the first instance classifies the argv link `second-instance` never sees", () => {
    // `second-instance` only ever fires on a LATER launch, so without this the
    // cold start is the one delivery path whose link nothing classifies.
    assert.deepEqual(
      classifyInitialDeepLink(["/usr/bin/closedloop", DESKTOP_DEEP_LINK_URL]),
      { rejection: null }
    );
    const { accepted, refused } = runReport([
      "/usr/bin/closedloop",
      DESKTOP_DEEP_LINK_URL,
    ]);
    assert.match(accepted.join("\n"), RE_LAUNCHED_BY_DEEP_LINK);
    assert.deepEqual(refused, []);
  });

  test("a hostile cold-start link is reported by reason, never by payload", () => {
    // The OS starts this process for ANY `closedloop://…` string before a line
    // of our code runs, so a cold start can only be reported, not refused. What
    // the policy still guarantees is what it guarantees everywhere: no handler
    // sees the payload, and no log line carries it.
    assert.deepEqual(
      classifyInitialDeepLink([
        "/usr/bin/closedloop",
        "closedloop://evil.example/steal",
      ]),
      { rejection: DeepLinkRejection.UnexpectedPayload }
    );
    const { accepted, refused } = runReport([
      "/usr/bin/closedloop",
      "closedloop://evil.example/steal",
    ]);
    assert.deepEqual(accepted, []);
    assert.match(refused.join("\n"), RE_UNEXPECTED_PAYLOAD);
    assert.doesNotMatch(refused.join("\n"), RE_EVIL_HOST);
  });
});

describe("protocol-client registration", () => {
  test("a packaged build registers on every platform", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      assert.equal(
        shouldRegisterProtocolClient({ isPackaged: true, platform }),
        true,
        platform
      );
    }
  });

  test("an unpackaged macOS build does NOT claim the scheme", () => {
    // Registering from a dev build would point LaunchServices at the generic
    // Electron binary and steal `closedloop://` from an installed Closedloop.app
    // — worse than the dead button this ticket fixes.
    assert.equal(
      shouldRegisterProtocolClient({ isPackaged: false, platform: "darwin" }),
      false
    );
  });

  test("an unpackaged Windows/Linux build does register", () => {
    for (const platform of ["win32", "linux"] as const) {
      assert.equal(
        shouldRegisterProtocolClient({ isPackaged: false, platform }),
        true,
        platform
      );
    }
  });

  test("a packaged build registers by bundle, with no explicit path", () => {
    const registration = resolveProtocolClientRegistration({
      argv: ["/Applications/Closedloop.app/Contents/MacOS/Closedloop"],
      execPath: "/Applications/Closedloop.app/Contents/MacOS/Closedloop",
      isPackaged: true,
    });
    assert.equal(registration.scheme, "closedloop");
    assert.equal(registration.path, undefined);
    assert.equal(registration.args, undefined);
  });

  test("an unpackaged build registers the electron binary plus the app dir", () => {
    const registration = resolveProtocolClientRegistration({
      argv: ["/node_modules/electron/dist/electron", "./apps/desktop"],
      execPath: "/node_modules/electron/dist/electron",
      isPackaged: false,
    });
    assert.equal(registration.path, "/node_modules/electron/dist/electron");
    // Resolved, because the OS re-launches from an arbitrary working directory.
    assert.equal(registration.args?.length, 1);
    assert.ok(registration.args?.[0].startsWith("/"), registration.args?.[0]);
  });

  test("never resolves an incoming deep link into the persisted app path", () => {
    // `args` is persisted by the OS (Windows registry command line, Linux
    // .desktop Exec). After a bare-form re-launch the OS-appended URL is itself
    // argv[1], so without this guard an attacker-supplied string would be
    // resolved into that durable registration.
    const registration = resolveProtocolClientRegistration({
      argv: ["/electron", "closedloop://evil.example/steal"],
      execPath: "/electron",
      isPackaged: false,
    });
    assert.equal(registration.path, undefined);
    assert.equal(registration.args, undefined);
  });

  test("an unpackaged build with no app-path argument falls back to the bare form", () => {
    const registration = resolveProtocolClientRegistration({
      argv: ["/node_modules/electron/dist/electron"],
      execPath: "/node_modules/electron/dist/electron",
      isPackaged: false,
    });
    assert.equal(registration.path, undefined);
  });

  test("registration is skipped, not attempted, on an unpackaged macOS build", () => {
    const calls: string[] = [];
    const logs: string[] = [];
    const registered = registerDeepLinkProtocolClient({
      argv: ["/electron", "./apps/desktop"],
      execPath: "/electron",
      isPackaged: false,
      log: (message) => logs.push(message),
      platform: "darwin",
      setAsDefaultProtocolClient: (scheme) => {
        calls.push(scheme);
        return true;
      },
    });
    assert.equal(registered, false);
    assert.deepEqual(calls, []);
    assert.match(logs.join("\n"), RE_UNPACKAGED_MACOS);
  });

  test("a packaged build hands the scheme to Electron and reports success", () => {
    const calls: string[] = [];
    const registered = registerDeepLinkProtocolClient({
      argv: ["/Applications/Closedloop.app/Contents/MacOS/Closedloop"],
      execPath: "/Applications/Closedloop.app/Contents/MacOS/Closedloop",
      isPackaged: true,
      log: () => undefined,
      platform: "darwin",
      setAsDefaultProtocolClient: (scheme) => {
        calls.push(scheme);
        return true;
      },
    });
    assert.equal(registered, true);
    assert.deepEqual(calls, ["closedloop"]);
  });

  test("an OS refusal degrades to a logged no-op, never a failed launch", () => {
    const logs: string[] = [];
    const registered = registerDeepLinkProtocolClient({
      argv: ["/app"],
      execPath: "/app",
      isPackaged: true,
      log: (message) => logs.push(message),
      platform: "win32",
      setAsDefaultProtocolClient: () => false,
    });
    assert.equal(registered, false);
    assert.match(logs.join("\n"), RE_REFUSED);
  });

  test("a throwing Electron API degrades to a logged no-op", () => {
    const logs: string[] = [];
    const registered = registerDeepLinkProtocolClient({
      argv: ["/app"],
      execPath: "/app",
      isPackaged: true,
      log: (message) => logs.push(message),
      platform: "linux",
      setAsDefaultProtocolClient: () => {
        throw new Error("no session bus");
      },
    });
    assert.equal(registered, false);
    assert.match(logs.join("\n"), RE_SESSION_BUS_ERROR);
  });
});
