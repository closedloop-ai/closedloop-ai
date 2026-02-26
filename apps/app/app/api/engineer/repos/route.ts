import { type NextRequest, NextResponse } from "next/server";
import { detectDeployment } from "@/lib/engineer/deploy-detect";
import {
  addRepo,
  expandHome,
  loadReposConfig,
  removeRepo,
  saveReposConfig,
  updateSettings,
} from "@/lib/engineer/repos";

/**
 * GET /api/repos
 *
 * List all configured repositories
 */
export function GET() {
  try {
    const config = loadReposConfig();

    // Auto-detect deployment config for repos missing config or missing port
    let configChanged = false;
    for (const repo of config.repos) {
      if (!repo.deployment?.port) {
        const detected = detectDeployment(expandHome(repo.path));
        if (detected) {
          repo.deployment = detected;
          configChanged = true;
        }
      }
    }
    if (configChanged) {
      saveReposConfig(config);
    }

    return NextResponse.json({
      repos: config.repos,
      settings: config.settings,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to list repos: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * POST /api/repos
 *
 * Add a new repository
 * Body: { path: string, description?: string }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { path, description } = body as {
      path: string;
      description?: string;
    };

    if (!path || typeof path !== "string") {
      return NextResponse.json(
        { error: "path is required and must be a string" },
        { status: 400 }
      );
    }

    const result = addRepo(path, description);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({
      success: true,
      repo: result.repo,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to add repo: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/repos?path=~/Source/my-repo
 *
 * Remove a repository from the configuration
 */
export function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const path = searchParams.get("path");

    if (!path) {
      return NextResponse.json(
        { error: "path query parameter is required" },
        { status: 400 }
      );
    }

    const result = removeRepo(path);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to remove repo: ${errorMessage}` },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/repos
 *
 * Update settings
 * Body: { worktreeParentDir?: string }
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { worktreeParentDir, worktreeParentDirConfirmed } = body as {
      worktreeParentDir?: string;
      worktreeParentDirConfirmed?: boolean;
    };

    const updates: Record<string, string | boolean> = {};

    if (worktreeParentDir !== undefined) {
      updates.worktreeParentDir = worktreeParentDir;
    }
    if (worktreeParentDirConfirmed !== undefined) {
      updates.worktreeParentDirConfirmed = worktreeParentDirConfirmed;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: "No settings to update" },
        { status: 400 }
      );
    }

    const result = updateSettings(updates);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to update settings: ${errorMessage}` },
      { status: 500 }
    );
  }
}
