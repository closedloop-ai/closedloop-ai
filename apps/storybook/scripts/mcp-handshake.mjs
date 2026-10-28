#!/usr/bin/env node
/**
 * ISS-10397 — the dev-server handshake for `@storybook/addon-mcp`'s `/mcp`.
 *
 * `storybook build` is a static export, so no build lane can see a dev-only
 * route: before this script the MCP endpoint shipped with no automated check
 * at all (review on PR #7270, whitlockk). This boots a real `storybook dev`, speaks
 * MCP to `/mcp` the way an agent does, and fails unless:
 *
 *   1. `tools/list` advertises every tool in REQUIRED_TOOLS — including
 *      `test-run`, which addon-mcp only advertises while `toolsets.test` is on
 *      in `.storybook/main.ts`;
 *   2. `docs-list` / `docs-show` answer from the components manifest
 *      (`features.componentsManifest`): the list carries the probe component
 *      and its stories, and showing it returns that component's docs;
 *   3. `test-run` really runs one of those stories through the browser-mode
 *      `storybookTest` project in `vitest.config.ts` and reports it passing —
 *      a tool that is advertised but cannot run is the state ISS-10397 was
 *      filed against.
 *
 * Ids are read from `docs-list`, never hard-coded: a story's id moves with its
 * title (taxonomy re-homes, version roots), and a stale literal would fail this
 * check for a reason that has nothing to do with `/mcp`.
 *
 * Usage: `pnpm --filter storybook test:mcp`. Set `STORYBOOK_MCP_URL` to check
 * a dev server that is already running instead of booting one; the script then
 * leaves that server alone. The Storybook Browser Nightly workflow runs it.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Not 6006: a developer's own `pnpm dev` usually holds that one, and
 * `--exact-port` makes a taken port a loud failure rather than a silent hop to
 * the next free port that this script would then never connect to.
 */
const DEFAULT_PORT = 6116;

/** Cold `storybook dev` on this corpus: docgen plus the first preview compile. */
const BOOT_TIMEOUT_MS = 10 * 60_000;
/** One story through Vitest browser mode, including its first Vite optimize. */
const TEST_RUN_TIMEOUT_MS = 10 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;

const REQUIRED_TOOLS = [
  "docs-list",
  "docs-show",
  "get-storybook-story-instructions",
  "stories-preview",
  "test-run",
];

/** The design-system Button: documented in every Storybook revision. */
const PROBE_COMPONENT = "Button";
/** `- Button (<component id>): …` in `docs-list`. */
const COMPONENT_LINE = /^- Button \(([\w-]+)\)/;
/** `  - Default (<story id>)` under it, with `withStoryIds: true`. */
const STORY_LINE = /^ {2}- .+ \(([\w-]+--[\w-]+)\)$/;
const PASSING_HEADING = /^## Passing Stories$/m;
const FAILING_HEADING = /^## (Failing|Errored)/m;
const WHITESPACE = /\s+/g;

class HandshakeError extends Error {}

function fail(message) {
  throw new HandshakeError(message);
}

/**
 * One JSON-RPC reply from a Streamable-HTTP response body: the body itself
 * when it is JSON, or the last SSE `data:` line when the server answered as
 * an event stream. `undefined` for an empty body (a notification's 202).
 */
export function parseRpcReply(text, contentType) {
  const payload = contentType.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .filter(Boolean)
        .at(-1)
    : text.trim();
  return payload ? JSON.parse(payload) : undefined;
}

/**
 * Streamable-HTTP MCP client, just enough for a handshake: one session, each
 * JSON-RPC request answered as JSON or as one SSE `message` event.
 */
function createClient(endpoint) {
  let sessionId;
  let nextId = 1;

  async function post(body, timeoutMs) {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    if (!response.ok) {
      fail(`${body.method}: HTTP ${response.status} ${text.slice(0, 500)}`);
    }
    return parseRpcReply(text, response.headers.get("content-type") ?? "");
  }

  return {
    async request(method, params, timeoutMs = REQUEST_TIMEOUT_MS) {
      const reply = await post(
        { jsonrpc: "2.0", id: nextId++, method, params },
        timeoutMs
      );
      if (!reply) {
        fail(`${method}: empty response`);
      }
      if (reply.error) {
        fail(`${method}: ${JSON.stringify(reply.error)}`);
      }
      return reply.result;
    },
    async notify(method) {
      await post({ jsonrpc: "2.0", method }, REQUEST_TIMEOUT_MS);
    },
  };
}

async function callTool(client, name, args, timeoutMs) {
  const result = await client.request(
    "tools/call",
    { name, arguments: args },
    timeoutMs
  );
  const text = (result?.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result?.isError) {
    fail(`${name} returned an error: ${text.slice(0, 2000)}`);
  }
  return text;
}

/** The probe component's id and its first story id, read from `docs-list`. */
export function findProbeIds(list) {
  const lines = list.split("\n");
  const start = lines.findIndex((line) => COMPONENT_LINE.test(line));
  if (start === -1) {
    fail(
      `docs-list does not list ${PROBE_COMPONENT}; is features.componentsManifest still on in .storybook/main.ts? Got: ${list.slice(0, 500)}`
    );
  }
  const componentId = lines[start].match(COMPONENT_LINE)[1];
  const storyId = lines[start + 1]?.match(STORY_LINE)?.[1];
  if (!storyId) {
    fail(
      `docs-list lists ${PROBE_COMPONENT} (${componentId}) with no story ids`
    );
  }
  return { componentId, storyId };
}

async function runHandshake(baseUrl, log = console.log) {
  const client = createClient(new URL("/mcp", baseUrl));

  const init = await client.request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "storybook-mcp-handshake", version: "1.0.0" },
  });
  log(`initialize: ${init?.serverInfo?.name}@${init?.serverInfo?.version}`);
  await client.notify("notifications/initialized");

  const { tools = [] } = (await client.request("tools/list", {})) ?? {};
  const names = tools.map((tool) => tool.name).sort();
  log(`tools/list: ${names.join(", ")}`);
  const missing = REQUIRED_TOOLS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    fail(
      `/mcp does not advertise ${missing.join(", ")}. test-run needs toolsets.test on in .storybook/main.ts.`
    );
  }

  const list = await callTool(client, "docs-list", { withStoryIds: true });
  const { componentId, storyId } = findProbeIds(list);
  log(`docs-list: ${list.length} chars; ${PROBE_COMPONENT} = ${componentId}`);

  const doc = await callTool(client, "docs-show", { id: componentId });
  if (!(doc.includes(`# ${PROBE_COMPONENT}`) && doc.includes(storyId))) {
    fail(
      `docs-show(${componentId}) did not return ${PROBE_COMPONENT}'s docs: ${doc.slice(0, 500)}`
    );
  }
  log(`docs-show(${componentId}): ${doc.length} chars`);

  const run = await callTool(
    client,
    "test-run",
    { stories: [{ storyId }] },
    TEST_RUN_TIMEOUT_MS
  );
  log(`test-run(${storyId}): ${run.replace(WHITESPACE, " ").slice(0, 300)}`);
  if (
    !(PASSING_HEADING.test(run) && run.includes(storyId)) ||
    FAILING_HEADING.test(run)
  ) {
    fail(`test-run did not report ${storyId} passing: ${run.slice(0, 2000)}`);
  }
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // A child killed by a signal (an OOM kill on a cold compile, say) keeps
    // `exitCode` null and sets `signalCode`, so both are checked: otherwise
    // this would poll a dead server for the whole boot timeout.
    if (child.exitCode !== null || child.signalCode !== null) {
      fail(
        `storybook dev exited (${child.signalCode ?? `code ${child.exitCode}`}) before answering`
      );
    }
    try {
      const response = await fetch(new URL("/index.json", baseUrl), {
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail(
    `storybook dev did not answer at ${baseUrl} within ${BOOT_TIMEOUT_MS / 1000}s`
  );
}

function startStorybook(port) {
  const child = spawn(
    "pnpm",
    [
      "exec",
      "storybook",
      "dev",
      "--port",
      String(port),
      "--exact-port",
      "--ci",
      "--no-open",
    ],
    {
      cwd: PACKAGE_DIR,
      stdio: ["ignore", "inherit", "inherit"],
      // Its own process group, so stopping it also stops storybook's children:
      // addon-vitest's Vitest process and the Chromium it drives.
      detached: true,
    }
  );
  const stop = () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };
  process.on("exit", stop);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      stop();
      process.exit(130);
    });
  }
  return { child, stop };
}

async function main() {
  const external = process.env.STORYBOOK_MCP_URL;
  const port = Number(process.env.STORYBOOK_MCP_PORT ?? DEFAULT_PORT);
  const baseUrl = external ?? `http://localhost:${port}`;
  const server = external ? undefined : startStorybook(port);
  try {
    if (server) {
      await waitForServer(baseUrl, server.child);
    }
    await runHandshake(baseUrl);
    console.log("storybook /mcp handshake: OK");
  } finally {
    server?.stop();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      error instanceof HandshakeError
        ? `storybook /mcp handshake FAILED: ${error.message}`
        : error
    );
    process.exit(1);
  });
}
