import { spawn } from "node:child_process";

export const dynamic = "force-dynamic";

const VERSION_REGEX = /codex-cli ([\d.]+)/;

export function GET() {
  return new Promise<Response>((resolve) => {
    const child = spawn("codex", ["--version"], { timeout: 5000 });
    let output = "";

    child.stdout.on("data", (data: Buffer) => {
      output += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        const versionMatch = VERSION_REGEX.exec(output.trim());
        const version = versionMatch?.[1] || "unknown";
        resolve(Response.json({ available: true, version }));
      } else {
        resolve(Response.json({ available: false }));
      }
    });

    child.on("error", () => {
      resolve(Response.json({ available: false }));
    });
  });
}
