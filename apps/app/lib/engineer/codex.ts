let cachedResult: boolean | null = null;

export async function isCodexInstalled(): Promise<boolean> {
  if (cachedResult !== null) {
    return cachedResult;
  }
  try {
    const { execSync } = await import("node:child_process");
    execSync("codex --version", { timeout: 5000, stdio: "ignore" });
    cachedResult = true;
  } catch {
    cachedResult = false;
  }
  return cachedResult;
}
