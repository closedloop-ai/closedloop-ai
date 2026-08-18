#!/usr/bin/env node

/**
 * @file statusline-capture.js
 * @description First-party Claude Code `statusLine` command (FEA-3492 / PRD-539).
 * Claude Code invokes the configured `statusLine.command` on every interactive
 * render, passing a JSON payload on stdin that includes `rate_limits.five_hour`
 * / `rate_limits.seven_day` (`used_percentage`, `resets_at`) and
 * `cost.total_cost_usd`. This is the rich, continuous utilization source.
 *
 * On each invocation this script:
 *   1. reads the JSON payload on stdin (fully buffered),
 *   2. writes a point-in-time snapshot (5h/7d utilization + resets + total cost)
 *      to the store file baked into its config, and
 *   3. prints a status line to stdout — passing through the user's pre-existing
 *      statusLine command unchanged when one was wrapped at install time, else a
 *      minimal built-in render.
 *
 * SECURITY BOUNDARY: this script never reads the user's OAuth credential. It
 * only consumes the payload Claude Code hands it on stdin.
 *
 * Zero-dependency, plain CommonJS, fail-silent: it runs via the Electron binary
 * as Node (ELECTRON_RUN_AS_NODE) from a userData copy and must NEVER crash a
 * Claude render — malformed/empty stdin still prints a status line and exits 0.
 *
 * Snapshot shape (written to `config.snapshotPath`):
 *   {
 *     fiveHour:  { utilization: number, resetsAt: string | null } | null,
 *     sevenDay:  { utilization: number, resetsAt: string | null } | null,
 *     totalCostUsd: number | null,
 *     fetchedAt: string   // ISO timestamp
 *   }
 *
 * Config file (path in env `CLOSEDLOOP_STATUSLINE_CONFIG`, written by the
 * desktop installer):
 *   { snapshotPath: string, wrappedCommand: string | null }
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/** Read + parse the installer-written config; tolerate any IO/parse failure. */
function readConfig() {
  const configPath = process.env.CLOSEDLOOP_STATUSLINE_CONFIG;
  if (!configPath) {
    return { snapshotPath: null, wrappedCommand: null };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object") {
      return {
        snapshotPath:
          typeof parsed.snapshotPath === "string" ? parsed.snapshotPath : null,
        wrappedCommand:
          typeof parsed.wrappedCommand === "string"
            ? parsed.wrappedCommand
            : null,
      };
    }
  } catch {
    // fall through to defaults
  }
  return { snapshotPath: null, wrappedCommand: null };
}

/**
 * Normalize a `rate_limits.*.resets_at` into the ISO string the snapshot
 * consumer (`RateLimitSnapshot.resetsAt: string | null`) expects. Claude Code
 * documents this as Unix epoch *seconds* (e.g. 1738425600); tolerate an ISO
 * string too. Anything else (a non-finite/non-positive number, or a value
 * `Date` can't represent) → null, fail-silent.
 */
function toResetsAt(value) {
  if (typeof value === "string") {
    return value.length > 0 ? value : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    try {
      return new Date(value * 1000).toISOString();
    } catch {
      return null;
    }
  }
  return null;
}

/** Map one `rate_limits.*` window into the snapshot's camelCase shape. */
function toRateLimit(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const used =
    typeof value.used_percentage === "number" ? value.used_percentage : null;
  if (used === null) {
    return null;
  }
  return {
    utilization: used,
    resetsAt: toResetsAt(value.resets_at),
  };
}

/** Build the point-in-time snapshot from a parsed statusLine payload. */
function buildSnapshot(json, fetchedAt) {
  const data = json && typeof json === "object" ? json : {};
  const rateLimits =
    data.rate_limits && typeof data.rate_limits === "object"
      ? data.rate_limits
      : {};
  const cost = data.cost && typeof data.cost === "object" ? data.cost : {};
  return {
    fiveHour: toRateLimit(rateLimits.five_hour),
    sevenDay: toRateLimit(rateLimits.seven_day),
    totalCostUsd:
      typeof cost.total_cost_usd === "number" ? cost.total_cost_usd : null,
    fetchedAt,
  };
}

/** Atomically write the snapshot; never throw (best-effort side effect). */
function writeSnapshot(snapshotPath, snapshot) {
  if (!snapshotPath) {
    return;
  }
  try {
    const dir = path.dirname(snapshotPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${snapshotPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(snapshot)}\n`, "utf8");
    fs.renameSync(tmp, snapshotPath);
  } catch {
    // A failed snapshot write must never break the status line.
  }
}

/** A compact built-in status line used when no user command was wrapped. */
function minimalRender(snapshot) {
  const segments = [];
  if (snapshot.fiveHour) {
    segments.push(`5h ${Math.round(snapshot.fiveHour.utilization)}%`);
  }
  if (snapshot.sevenDay) {
    segments.push(`7d ${Math.round(snapshot.sevenDay.utilization)}%`);
  }
  if (snapshot.totalCostUsd !== null) {
    segments.push(`$${snapshot.totalCostUsd.toFixed(2)}`);
  }
  return segments.join(" · ");
}

/**
 * Compose with the user's pre-existing statusLine: re-run their command with
 * the same stdin payload and pass its stdout through verbatim. Returns null if
 * there is no wrapped command or it fails, so the caller falls back to the
 * minimal render (composition must never break the render).
 */
function renderWrapped(wrappedCommand, stdin) {
  if (!wrappedCommand) {
    return null;
  }
  try {
    return execFileSync(wrappedCommand, {
      shell: true,
      input: stdin,
      encoding: "utf8",
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
  } catch (error) {
    // Some statusline scripts intentionally exit non-zero but still emit their
    // line on stdout — honor that stdout rather than discarding it.
    const out = error && typeof error === "object" ? error.stdout : null;
    return typeof out === "string" && out.length > 0 ? out : null;
  }
}

function main(stdin, done) {
  const config = readConfig();

  let parsed;
  try {
    parsed = JSON.parse(stdin);
  } catch {
    parsed = null;
  }

  const snapshot = buildSnapshot(parsed, new Date().toISOString());
  writeSnapshot(config.snapshotPath, snapshot);

  // Prefer the wrapped user command's output, but fall back to the built-in
  // render whenever it produced nothing (null, empty, or whitespace-only) so a
  // silent user command never blanks the status line.
  const wrapped = renderWrapped(config.wrappedCommand, stdin);
  const line =
    wrapped && wrapped.trim().length > 0 ? wrapped : minimalRender(snapshot);
  // Flush stdout before exiting: process.exit() drops queued pipe writes, which
  // could truncate a large wrapped render. Exit only once the write completes.
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`, done);
}

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const done = () => process.exit(0);
  try {
    main(input, done);
  } catch {
    // Absolute last resort: never crash a Claude render.
    process.stdout.write("\n", done);
  }
});

// Safety net — never linger longer than Claude's statusLine timeout.
setTimeout(() => process.exit(0), 6000);
