#!/usr/bin/env node
/**
 * @file reset-dashboard-db.mjs — wipe the in-process Agent Dashboard DB.
 *
 * Full wipe — removes the SQLite `agent-dashboard.pgdata` directory.
 * Loses all collected sessions, events, agents, and token usage. Use for
 * first-time-user-experience (FTUE) testing — the next launch re-derives history
 * from the on-disk agent-CLI transcripts (FEA-1503 collection layer).
 *
 * The Closedloop app must be STOPPED before running this — SQLite owns the
 * data directory and the in-process hook listener holds 127.0.0.1:4820. The script
 * refuses with a clear message if the app is still running (port 4820 is bound).
 *
 * Cross-platform DB path resolution mirrors `app.getPath("userData")` from the
 * Electron main process (`<userData>/agent-dashboard.pgdata`).
 */
import { existsSync } from "node:fs";
import net from "node:net";
import { dashboardDbPath, removeAll } from "./reset-dashboard-db-lib.mjs";

async function appIsRunning(port = 4820) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1", timeout: 200 }, () => {
      sock.end();
      resolve(true);
    });
    sock.on("error", () => resolve(false));
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
  });
}

async function main() {
  const dbPath = dashboardDbPath();

  if (await appIsRunning()) {
    console.error(
      "[reset-dashboard-db] Closedloop is running on 127.0.0.1:4820 — quit the\n" +
        "app first (Cmd-Q the tray icon) so the DB is unlocked."
    );
    process.exit(1);
  }

  if (!existsSync(dbPath)) {
    console.log(`[reset-dashboard-db] No DB at ${dbPath} — nothing to do.`);
    return;
  }

  removeAll(dbPath);
  console.log(
    "[reset-dashboard-db] Full DB wiped. Next launch starts at FTUE state and\n" +
      "re-imports history from your on-disk agent-CLI transcripts."
  );
}

main().catch((err) => {
  console.error("[reset-dashboard-db] failed:", err);
  process.exit(1);
});
