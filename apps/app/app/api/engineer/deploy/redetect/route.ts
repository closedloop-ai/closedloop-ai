import { type NextRequest, NextResponse } from "next/server";
import { detectDeployment } from "@/lib/engineer/deploy-detect";
import {
  expandHome,
  loadReposConfig,
  saveReposConfig,
} from "@/lib/engineer/repos";

/**
 * API route to re-detect deployment configuration
 * Called after a cached deploy/teardown command fails.
 *
 * POST /api/deploy/redetect
 * Body: { repoPath }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { repoPath } = body as { repoPath: string };

    if (!repoPath) {
      return NextResponse.json(
        { error: "repoPath is required" },
        { status: 400 }
      );
    }

    const expandedRepoPath = expandHome(repoPath);
    const newConfig = detectDeployment(expandedRepoPath);

    const config = loadReposConfig();
    const repoEntry = config.repos.find(
      (r) => expandHome(r.path) === expandedRepoPath
    );

    if (newConfig && repoEntry) {
      repoEntry.deployment = newConfig;
      saveReposConfig(config);
      return NextResponse.json({ redetected: true, config: newConfig });
    }

    // No config found — clear stale entry
    if (repoEntry?.deployment) {
      repoEntry.deployment = undefined;
      saveReposConfig(config);
    }

    return NextResponse.json({ redetected: false });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to re-detect deployment config: ${errorMessage}` },
      { status: 500 }
    );
  }
}
