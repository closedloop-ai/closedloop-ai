import { type NextRequest, NextResponse } from "next/server";
import {
  checkPortListening,
  detectDeployment,
} from "@/lib/engineer/deploy-detect";
import { expandHome, loadReposConfig } from "@/lib/engineer/repos";

/**
 * API route to detect locally running dev servers
 *
 * POST /api/deploy/check-existing
 * Body: { repoPath, worktreePath }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repoPath, worktreePath } = body as {
      repoPath: string;
      worktreePath: string;
    };

    if (!(repoPath && worktreePath)) {
      return NextResponse.json(
        { error: "repoPath and worktreePath are required" },
        { status: 400 }
      );
    }

    const expandedRepoPath = expandHome(repoPath);
    const expandedWorktreePath = expandHome(worktreePath);

    // Look up deployment config from repos.json
    const config = loadReposConfig();
    const repoEntry = config.repos.find(
      (r) => expandHome(r.path) === expandedRepoPath
    );
    let deployConfig = repoEntry?.deployment;

    // If no config on base repo, try detecting from the worktree path
    deployConfig ??= detectDeployment(expandedWorktreePath) ?? undefined;

    // If still no config or no port, can't check
    if (!deployConfig?.port) {
      return NextResponse.json({ active: false });
    }

    const listening = await checkPortListening(deployConfig.port);

    if (listening) {
      return NextResponse.json({
        active: true,
        url: `http://localhost:${deployConfig.port}`,
      });
    }

    return NextResponse.json({ active: false });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to check existing deployment: ${errorMessage}` },
      { status: 500 }
    );
  }
}
