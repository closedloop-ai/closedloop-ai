import { type NextRequest, NextResponse } from "next/server";
import {
  detectDeployment,
  detectDeploymentWithLLM,
} from "@/lib/engineer/deploy-detect";
import {
  expandHome,
  loadReposConfig,
  saveReposConfig,
} from "@/lib/engineer/repos";

/**
 * API route for on-demand deployment detection (heuristic + LLM fallback)
 *
 * POST /api/deploy/detect
 * Body: { repoPath: string }
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

    // Try heuristic detection first
    let config = detectDeployment(expandedRepoPath);

    // If heuristic found a config with a port, save and return
    if (config?.port) {
      saveConfigToRepos(repoPath, expandedRepoPath, config);
      return NextResponse.json({ detected: true, config });
    }

    // If heuristic found something but no port, or found nothing, try LLM
    const llmConfig = await detectDeploymentWithLLM(expandedRepoPath);
    if (llmConfig) {
      config = llmConfig;
      saveConfigToRepos(repoPath, expandedRepoPath, config);
      return NextResponse.json({ detected: true, config });
    }

    // If heuristic found something without port and LLM failed, still save the heuristic result
    if (config) {
      saveConfigToRepos(repoPath, expandedRepoPath, config);
      return NextResponse.json({ detected: true, config });
    }

    return NextResponse.json({ detected: false });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to detect deployment: ${errorMessage}` },
      { status: 500 }
    );
  }
}

function saveConfigToRepos(
  repoPath: string,
  expandedRepoPath: string,
  config: NonNullable<ReturnType<typeof detectDeployment>>
): void {
  const reposConfig = loadReposConfig();
  const repoEntry = reposConfig.repos.find(
    (r) => expandHome(r.path) === expandedRepoPath || r.path === repoPath
  );
  if (repoEntry) {
    repoEntry.deployment = config;
    saveReposConfig(reposConfig);
  }
}
