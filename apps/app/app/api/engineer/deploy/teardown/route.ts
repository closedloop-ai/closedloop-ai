import { execSync } from "node:child_process";
import { type NextRequest, NextResponse } from "next/server";
import { expandHome, loadReposConfig } from "@/lib/engineer/repos";
import { getShellPath } from "@/lib/engineer/shell-path";

/**
 * API route to tear down a local dev server
 *
 * POST /api/engineer/deploy/teardown
 * Body: { repoPath, worktreePath, serviceId?, pid?, port? }
 *
 * Kill strategy (in order):
 * 1. Spawn PID → kill process group (-pid) since detached processes are group leaders
 * 2. Port → lsof -ti:PORT → kill each listener PID directly (no tree walk)
 * 3. Teardown command if configured
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repoPath, worktreePath, pid, port } = body as {
      repoPath: string;
      worktreePath: string;
      serviceId?: string;
      pid?: number;
      port?: number;
    };

    if (!(repoPath && worktreePath)) {
      return NextResponse.json(
        { error: "repoPath and worktreePath are required" },
        { status: 400 }
      );
    }

    const expandedRepoPath = expandHome(repoPath);
    const config = loadReposConfig();
    const repoEntry = config.repos.find(
      (r) => expandHome(r.path) === expandedRepoPath
    );
    const deployConfig = repoEntry?.deployment;
    const primaryPort = deployConfig?.port ?? port;

    // Try strategies in order: PID → ports → teardown command
    if (pid && killByPid(pid) === "killed") {
      return NextResponse.json({ success: true });
    }
    if (
      primaryPort &&
      killByPorts(primaryPort, deployConfig?.additionalPorts)
    ) {
      return NextResponse.json({ success: true });
    }
    if (
      deployConfig?.teardownCommand &&
      (await runTeardownCommand(deployConfig.teardownCommand, worktreePath))
    ) {
      return NextResponse.json({ success: true });
    }

    // Nothing available
    if (!(primaryPort || pid || deployConfig?.teardownCommand)) {
      return NextResponse.json(
        {
          error:
            "No port, PID, or teardown command available to stop the server",
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      success: false,
      error: "Could not stop the server — process may have already exited",
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to tear down deployment: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * Strategy 2: Sweep primary port + additional ports from config.
 * Only used when we didn't spawn the process ourselves (no PID).
 */
function killByPorts(primaryPort: number, additionalPorts?: number[]): boolean {
  const ports = new Set([primaryPort, ...(additionalPorts ?? [])]);
  let didKill = false;
  for (const p of ports) {
    const result = killByPort(p);
    if (result === "killed" || result === "none") {
      didKill = true;
    }
  }
  return didKill;
}

/**
 * Strategy 3: Run a configured teardown command in the worktree.
 */
async function runTeardownCommand(
  command: string,
  worktreePath: string
): Promise<boolean> {
  const shellPath = await getShellPath();
  try {
    execSync(command, {
      cwd: expandHome(worktreePath),
      shell: "/bin/bash",
      timeout: 60_000,
      stdio: "pipe",
      env: {
        ...process.env,
        PATH: shellPath,
      },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process by the PID we spawned. Since we use detached:true,
 * the process is its own group leader — killing -pid takes out the
 * entire group (e.g., just dev → pnpm → node) without walking the tree.
 *
 * Returns "killed" or "error".
 */
function killByPid(pid: number): "killed" | "error" {
  // Try process group kill first (negative PID)
  try {
    process.kill(-pid, "SIGTERM");
    return "killed";
  } catch {
    // Group kill failed — try direct kill as fallback
  }
  try {
    process.kill(pid, "SIGTERM");
    return "killed";
  } catch {
    return "error";
  }
}

/**
 * Kill processes listening on a port. Finds PIDs via lsof and kills
 * each one directly — no tree walking, no ancestor search.
 *
 * Returns "killed", "none" (nothing listening — already stopped), or "error".
 */
function killByPort(port: number): "killed" | "none" | "error" {
  try {
    const output = execSync(`lsof -ti:${port}`, {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    const pids = output
      .trim()
      .split("\n")
      .map((s) => Number.parseInt(s.trim(), 10))
      .filter((p) => !Number.isNaN(p));

    if (pids.length === 0) {
      return "none";
    }

    // Kill each listener PID directly
    let killed = false;
    for (const p of pids) {
      try {
        process.kill(p, "SIGTERM");
        killed = true;
      } catch {
        // PID already gone — that's fine
      }
    }
    return killed ? "killed" : "none";
  } catch {
    // lsof exits 1 when no process found — server is already stopped
    return "none";
  }
}
