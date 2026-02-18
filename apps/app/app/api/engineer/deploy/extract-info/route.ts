import { type NextRequest, NextResponse } from "next/server";
import { expandHome, loadReposConfig } from "@/lib/engineer/repos";

/**
 * API route to extract deployment details
 *
 * POST /api/engineer/deploy/extract-info
 * Body: { repoPath, logs }
 *
 * For local deployments, returns localhost:PORT directly.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repoPath } = body as { repoPath: string; logs: string };

    if (!repoPath) {
      return NextResponse.json(
        { error: "repoPath is required" },
        { status: 400 }
      );
    }

    const expandedRepoPath = expandHome(repoPath);
    const config = loadReposConfig();
    const repoEntry = config.repos.find(
      (r) => expandHome(r.path) === expandedRepoPath
    );
    const deployConfig = repoEntry?.deployment;

    // For local deployments with a port, return the localhost URL directly
    if (deployConfig?.port) {
      return NextResponse.json({
        url: `http://localhost:${deployConfig.port}`,
      });
    }

    // No port configured — return empty
    return NextResponse.json({
      url: null,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to extract deployment info: ${errorMessage}` },
      { status: 500 }
    );
  }
}
