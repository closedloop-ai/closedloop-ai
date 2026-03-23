import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getShellPathSync } from "@/lib/engineer/shell-path";
import type { DeploymentConfig } from "@/types/repos";

/**
 * Auto-detect local dev server configuration for a repository.
 * Checks justfile `dev` recipe first, then package.json `dev` script.
 */
export function detectDeployment(repoPath: string): DeploymentConfig | null {
  // Rule 1: justfile with `dev` recipe
  const justfilePath = join(repoPath, "justfile");
  if (existsSync(justfilePath)) {
    const content = readFileSync(justfilePath, "utf-8");
    if (/^dev(\s.*)?:/m.test(content)) {
      const body = getJustfileRecipeBody(content, "dev");
      const port = body ? extractPortFromCommand(body) : null;
      const config: DeploymentConfig = {
        type: "local",
        command: "just dev",
        detectedAt: new Date().toISOString(),
      };
      config.installCommand = `${detectPackageManager(repoPath)} install`;
      if (port) {
        config.port = port;
        config.healthCheckUrl = `http://localhost:${port}`;
      }
      // Scan only the workspace apps that turbo/pnpm actually starts (via --filter flags)
      const filters = body ? extractTurboFilters(body) : [];
      const workspacePorts =
        filters.length > 0 ? scanWorkspacePorts(repoPath, filters) : [];
      const additionalPorts = workspacePorts.filter((p) => p !== port);
      if (additionalPorts.length > 0) {
        config.additionalPorts = additionalPorts;
        // If no primary port yet, promote the first workspace port
        if (!config.port) {
          config.port = additionalPorts.shift()!;
          config.healthCheckUrl = `http://localhost:${config.port}`;
          config.additionalPorts =
            additionalPorts.length > 0 ? additionalPorts : undefined;
        }
      }
      return config;
    }
  }

  // Rule 2: package.json with `dev` script
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts?.dev) {
        const port = extractPortFromCommand(pkg.scripts.dev);
        const pm = detectPackageManager(repoPath);
        const config: DeploymentConfig = {
          type: "local",
          command: `${pm} run dev`,
          installCommand: `${pm} install`,
          detectedAt: new Date().toISOString(),
        };
        if (port) {
          config.port = port;
          config.healthCheckUrl = `http://localhost:${port}`;
        }
        return config;
      }
    } catch {
      // Invalid package.json
    }
  }

  return null;
}

/**
 * Detect deployment configuration using an LLM (Haiku) as fallback
 * when heuristic port extraction fails.
 */
export function detectDeploymentWithLLM(
  repoPath: string
): DeploymentConfig | null {
  let context = "";

  // Gather justfile content
  const justfilePath = join(repoPath, "justfile");
  if (existsSync(justfilePath)) {
    const content = readFileSync(justfilePath, "utf-8");
    context += `<justfile>\n${content.slice(0, 3000)}\n</justfile>\n`;
  }

  // Gather package.json scripts
  const pkgPath = join(repoPath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.scripts) {
        context += `<package-json-scripts>\n${JSON.stringify(pkg.scripts, null, 2)}\n</package-json-scripts>\n`;
      }
    } catch {
      // Invalid package.json
    }
  }

  if (!context) {
    return null;
  }

  const prompt = `You are analyzing a repository to find its local dev server command and port.

${context}

Return ONLY valid JSON with these fields:
{"command": "the command to start dev server", "port": 3000}

- "command" should be the full command (e.g., "just dev", "npm run dev")
- "port" should be the port number the dev server listens on (integer), or null if unknown
- Do NOT include any explanation, just the JSON object`;

  try {
    const output = execSync(
      `claude --model haiku -p ${JSON.stringify(prompt)}`,
      {
        timeout: 30_000,
        stdio: "pipe",
        encoding: "utf-8",
        env: {
          ...process.env,
          PATH: getShellPathSync(),
        },
      }
    );

    const jsonMatch = /\{[^}]+\}/.exec(output);
    if (!jsonMatch) {
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      command?: string;
      port?: number | null;
    };

    if (!parsed.command) {
      return null;
    }

    const config: DeploymentConfig = {
      type: "local",
      command: parsed.command,
      detectedAt: new Date().toISOString(),
    };

    if (parsed.port && parsed.port >= 1024 && parsed.port <= 65_535) {
      config.port = parsed.port;
      config.healthCheckUrl = `http://localhost:${parsed.port}`;
    }

    return config;
  } catch {
    return null;
  }
}

/**
 * Check if a port is currently listening by attempting an HTTP HEAD request.
 */
export async function checkPortListening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}`, {
      method: "HEAD",
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Extract a port number from a command string using common patterns.
 * Returns null if no valid port is found.
 */
function extractPortFromCommand(commandStr: string): number | null {
  const patterns = [
    /--port[= ](\d+)/,
    /-p\s+(\d+)/,
    /PORT[= ](\d+)/,
    /:(\d{4,5})\b/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(commandStr);
    if (match) {
      const port = Number.parseInt(match[1], 10);
      if (port >= 1024 && port <= 65_535) {
        return port;
      }
    }
  }

  return null;
}

/**
 * Extract the body lines of a justfile recipe by name.
 * Returns the concatenated indented lines below the recipe header.
 */
function getJustfileRecipeBody(
  content: string,
  recipeName: string
): string | null {
  const lines = content.split("\n");
  const headerPattern = new RegExp(`^${recipeName}(\\s.*)?:`);
  let inRecipe = false;
  const bodyLines: string[] = [];

  for (const line of lines) {
    if (inRecipe) {
      // Recipe body lines are indented (tab or spaces)
      if (/^[\t ]/.test(line)) {
        bodyLines.push(line);
      } else if (line.trim() === "") {
        // Blank lines within a recipe are OK
        bodyLines.push(line);
      } else {
        // Non-indented, non-blank line means next recipe
        break;
      }
    } else if (headerPattern.test(line)) {
      inRecipe = true;
    }
  }

  return bodyLines.length > 0 ? bodyLines.join("\n") : null;
}

/**
 * Detect the package manager for a repository by checking lockfiles.
 */
function detectPackageManager(repoPath: string): string {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(repoPath, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

/**
 * Scan workspace app directories for dev script ports, limited to the apps
 * that turbo actually starts (from --filter flags). Only checks apps/* and
 * packages/* directories whose folder name matches a filter entry.
 */
function scanWorkspacePorts(repoPath: string, filters: string[]): number[] {
  const ports: number[] = [];
  const filterSet = new Set(filters);
  const workspaceDirs = ["apps", "packages"];

  for (const dir of workspaceDirs) {
    const fullDir = join(repoPath, dir);
    if (!existsSync(fullDir)) {
      continue;
    }
    try {
      for (const entry of readdirSync(fullDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        if (!filterSet.has(entry.name)) {
          continue;
        }
        const pkgPath = join(fullDir, entry.name, "package.json");
        if (!existsSync(pkgPath)) {
          continue;
        }
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
          const scripts: Record<string, string> = pkg.scripts ?? {};
          extractPortsFromScripts(scripts, ports);
        } catch {
          // Invalid package.json
        }
      }
    } catch {
      // Can't read directory
    }
  }

  return ports;
}

/**
 * Extract ports from a package.json scripts object.
 * Checks the `dev` script, then any scripts referenced via `npm:*` patterns
 * (used by concurrently), and finally all remaining scripts.
 */
function extractPortsFromScripts(
  scripts: Record<string, string>,
  ports: number[]
): void {
  // Collect script names to scan: dev first, then npm:* references, then all others
  const scanned = new Set<string>();
  const toScan: string[] = [];

  if (scripts.dev) {
    toScan.push("dev");
    // concurrently uses "npm:next", "npm:stripe" → resolve to script names
    const npmRefs = scripts.dev.matchAll(/"npm:(\w+)"/g);
    for (const ref of npmRefs) {
      if (scripts[ref[1]]) {
        toScan.push(ref[1]);
      }
    }
  }

  // Add remaining scripts as fallback
  for (const name of Object.keys(scripts)) {
    if (!toScan.includes(name)) {
      toScan.push(name);
    }
  }

  for (const name of toScan) {
    if (scanned.has(name)) {
      continue;
    }
    scanned.add(name);
    const port = extractPortFromCommand(scripts[name]);
    if (port && !ports.includes(port)) {
      ports.push(port);
    }
  }
}

/**
 * Extract --filter= values from a turbo/pnpm command string.
 * e.g., `pnpm turbo dev --filter=app --filter=api` → ["app", "api"]
 */
function extractTurboFilters(command: string): string[] {
  const filters: string[] = [];
  const matches = command.matchAll(/--filter[= ](\S+)/g);
  for (const m of matches) {
    filters.push(m[1]);
  }
  return filters;
}
