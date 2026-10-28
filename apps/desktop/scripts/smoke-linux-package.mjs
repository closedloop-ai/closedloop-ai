import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const executablePath = process.argv[2];
if (!executablePath) {
  throw new Error("Pass the extracted Linux application executable");
}
const smokeHome = await mkdtemp(path.join(tmpdir(), "closedloop-linux-smoke-"));
const codexHome = path.join(smokeHome, ".codex");
await mkdir(codexHome);
let app;
try {
  app = await electron.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-gpu",
      "--e2e-no-reveal",
      "--e2e-ephemeral-loopback-ports",
      `--user-data-dir=${path.join(smokeHome, "user-data")}`,
    ],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      DISPLAY: process.env.DISPLAY ?? ":99",
      ...(process.env.XAUTHORITY && { XAUTHORITY: process.env.XAUTHORITY }),
      HOME: smokeHome,
      CODEX_HOME: codexHome,
      XDG_CONFIG_HOME: path.join(smokeHome, "config"),
      XDG_DATA_HOME: path.join(smokeHome, "data"),
      XDG_CACHE_HOME: path.join(smokeHome, "cache"),
    },
    timeout: 60_000,
  });
  const window = await app.firstWindow({ timeout: 60_000 });
  await window.waitForFunction(
    () => globalThis.document.body.innerText.trim().length > 0,
    undefined,
    { timeout: 60_000 }
  );
  const runtime = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    platform: process.platform,
    version: electronApp.getVersion(),
  }));
  if (!(runtime.packaged && runtime.platform === "linux" && runtime.version)) {
    throw new Error("The packaged Linux application did not start correctly");
  }
  console.log(`Linux packaged application launched: ${runtime.version}`);
} finally {
  await app?.close();
  await rm(smokeHome, { recursive: true, force: true });
}
