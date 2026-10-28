/**
 * @file dev-launch-bridge-handoff.test.ts
 * @description ISS-8412 — the host launch token must not reach Electron's argv.
 *
 * Process arguments are world-readable on macOS and Linux, so a host token on
 * the `--closedloop-renderer-url=` argument handed every local process a
 * credential that mints an authorized bridge host. These cases pin the two
 * places that could put it back: the URL builder that used to set the parameter,
 * and the launch-options builder that turns that URL into argv.
 *
 * The production wiring beyond this seam — main reading the environment and
 * appending the parameter to the URL it loads — is proven end to end by
 * `test/e2e/browser-bridge-sidecar.spec.ts`, which cannot mount its tab unless
 * the real Electron renderer authenticated as the host.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "vitest";
import {
  buildDevLaunchUrls,
  buildElectronLaunchOptions,
  RENDERER_URL_ARG_PREFIX,
} from "../scripts/dev-launch-bridge-handoff.mjs";
import { E2E_EPHEMERAL_LOOPBACK_PORTS_ARG } from "../src/main/lifecycle/loopback-port-isolation.js";
import {
  desktopBrowserBridgeHostTokenEnvVar,
  desktopBrowserBridgeTokenParam,
} from "../src/shared/desktop-browser-bridge-contract.mjs";
import {
  gatewayListenGateEnv,
  gatewayListenGateLaunchArgs,
} from "./e2e/helpers/gateway-listen-gate.js";

const ARGV_LEAK_REFUSAL = /world-readable/;
const BASE_URL = "http://127.0.0.1:5199/";
const CLIENT_TOKEN = "c".repeat(43);
const HOST_TOKEN = "h".repeat(43);

test("the Electron entry URL carries no launch token at all", () => {
  const urls = buildDevLaunchUrls({
    baseUrl: BASE_URL,
    clientToken: CLIENT_TOKEN,
  });

  const rendererUrl = new URL(urls.rendererUrl);
  assert.equal(
    rendererUrl.searchParams.has(desktopBrowserBridgeTokenParam),
    false,
    "the URL Electron is launched with carried a bridge token"
  );
  assert.equal(rendererUrl.search, "");

  // The reader's own entry still carries its own token: that URL is printed for
  // the operator and never becomes anyone's process argument.
  assert.equal(
    new URL(urls.browserUrl).searchParams.get(desktopBrowserBridgeTokenParam),
    CLIENT_TOKEN
  );
});

test("a launch without the bridge builds no browser URL", () => {
  const urls = buildDevLaunchUrls({ baseUrl: BASE_URL, clientToken: "" });

  assert.equal(urls.browserUrl, "");
  assert.equal(new URL(urls.rendererUrl).search, "");
});

test("the host token reaches Electron in its environment, never in its argv", () => {
  const urls = buildDevLaunchUrls({
    baseUrl: BASE_URL,
    clientToken: CLIENT_TOKEN,
  });
  const launch = buildElectronLaunchOptions({
    argv: ["node", "dev-launch.mjs", "--browser-bridge", "--", "--no-sandbox"],
    baseEnv: { PATH: "/usr/bin" },
    hostToken: HOST_TOKEN,
    rendererUrl: urls.rendererUrl,
    useStaticRenderer: false,
  });

  assert.equal(
    launch.args.join(" ").includes(HOST_TOKEN),
    false,
    "the host launch token was published in Electron's process arguments"
  );
  assert.equal(
    launch.args.join(" ").includes(CLIENT_TOKEN),
    false,
    "the reader launch token was published in Electron's process arguments"
  );
  assert.deepEqual(launch.args, [
    ".",
    `${RENDERER_URL_ARG_PREFIX}${urls.rendererUrl}`,
    "--no-sandbox",
  ]);
  assert.equal(launch.env[desktopBrowserBridgeHostTokenEnvVar], HOST_TOKEN);
  assert.equal(launch.env.PATH, "/usr/bin");
});

test("a launch without the bridge sets no host-token variable", () => {
  const launch = buildElectronLaunchOptions({
    argv: ["node", "dev-launch.mjs"],
    baseEnv: { PATH: "/usr/bin" },
    hostToken: "",
    rendererUrl: `${BASE_URL}design-system/index.html`,
    useStaticRenderer: false,
  });

  assert.equal(
    Object.hasOwn(launch.env, desktopBrowserBridgeHostTokenEnvVar),
    false
  );
});

test("a static-renderer launch passes no renderer URL and still carries the token in env", () => {
  const launch = buildElectronLaunchOptions({
    argv: ["node", "dev-launch.mjs", "--static-renderer"],
    baseEnv: {},
    hostToken: HOST_TOKEN,
    rendererUrl: "",
    useStaticRenderer: true,
  });

  assert.deepEqual(launch.args, ["."]);
  assert.equal(launch.env[desktopBrowserBridgeHostTokenEnvVar], HOST_TOKEN);
});

// The seam's own guard, so reintroducing the parameter anywhere upstream fails
// at launch instead of quietly republishing the credential to `ps`.
test("a renderer URL carrying a bridge token is refused rather than launched", () => {
  const leaking = new URL(`${BASE_URL}design-system/index.html`);
  leaking.searchParams.set(desktopBrowserBridgeTokenParam, HOST_TOKEN);

  assert.throws(
    () =>
      buildElectronLaunchOptions({
        argv: ["node", "dev-launch.mjs"],
        baseEnv: {},
        hostToken: HOST_TOKEN,
        rendererUrl: leaking.href,
        useStaticRenderer: false,
      }),
    ARGV_LEAK_REFUSAL
  );
});

test("the real shared gateway preload precedes the app entry while the profile and remaining switches retain their order", () => {
  const profile = path.resolve("sidecar-test-profile");
  const prefix = gatewayListenGateLaunchArgs();
  const forwarded = [
    "--no-sandbox",
    ...prefix,
    `--user-data-dir=${profile}`,
    E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
  ];
  const env = gatewayListenGateEnv(false, profile);
  const launch = buildElectronLaunchOptions({
    argv: ["node", "dev-launch.mjs", "--browser-bridge", "--", ...forwarded],
    baseEnv: env,
    hostToken: "",
    rendererUrl: `${BASE_URL}design-system/index.html`,
    useStaticRenderer: false,
  });
  assert.deepEqual(launch.args, [
    ...prefix,
    ".",
    `${RENDERER_URL_ARG_PREFIX}${BASE_URL}design-system/index.html`,
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    E2E_EPHEMERAL_LOOPBACK_PORTS_ARG,
  ]);
  assert.equal(launch.env, env);
});

test("paired short and long preload switches preserve module order before a static entry", () => {
  const launch = buildElectronLaunchOptions({
    argv: [
      "node",
      "dev-launch.mjs",
      "--",
      "--no-sandbox",
      "-r",
      "first.cjs",
      "--user-data-dir=profile",
      "--require",
      "second.cjs",
    ],
    baseEnv: {},
    hostToken: "",
    rendererUrl: "",
    useStaticRenderer: true,
  });
  assert.deepEqual(launch.args, [
    "-r",
    "first.cjs",
    "--require",
    "second.cjs",
    ".",
    "--no-sandbox",
    "--user-data-dir=profile",
  ]);
});

test("an incomplete preload pair does not consume a following switch or move a bare trailing switch", () => {
  const launch = buildElectronLaunchOptions({
    argv: ["node", "dev-launch.mjs", "--", "-r", "--no-sandbox", "--require"],
    baseEnv: {},
    hostToken: "",
    rendererUrl: "",
    useStaticRenderer: true,
  });
  assert.deepEqual(launch.args, [".", "-r", "--no-sandbox", "--require"]);
});
