import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { finalizeBrowserSourceMaps } from "./upload-sourcemaps.mjs";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const child = spawn(
  process.execPath,
  [nextBin, "build", ...process.argv.slice(2)],
  {
    env: {
      ...process.env,
      CI: process.env.CI ?? "1",
    },
    stdio: ["ignore", "inherit", "inherit"],
  }
);

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  // ISS-7766: only after a successful build. It can fail the build, but only
  // for ISS-8925's one reason — a source map in the tree about to be served.
  // Every telemetry failure inside it still returns quietly.
  if (code === 0) {
    finalizeBrowserSourceMaps();
  }

  process.exit(code ?? 1);
});
