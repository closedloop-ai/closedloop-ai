import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type NextRequest, NextResponse } from "next/server";

/**
 * API route to check Symphony run status
 *
 * GET /api/symphony/status?workDir=/path/to/workdir
 *
 * Checks if Symphony is still running by examining the state.json file
 * in the .closedloop directory of the work directory.
 */
export function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const workDir = searchParams.get("workDir");

  if (!workDir) {
    return NextResponse.json(
      { error: "workDir parameter is required" },
      { status: 400 }
    );
  }

  try {
    // Orchestrator writes state.json to $CLOSEDLOOP_WORKDIR
    const stateFile = join(workDir, ".closedloop-ai", "work", "state.json");

    // Check if state file exists
    if (!existsSync(stateFile)) {
      return NextResponse.json({
        isRunning: false,
        reason: "state.json not found",
      });
    }

    // Read and parse state file
    const stateContent = readFileSync(stateFile, "utf-8");
    const state = JSON.parse(stateContent);

    // Check the status to determine if still running
    // Symphony sets status to "COMPLETED" or "ERROR" when done
    const completedStatuses = ["COMPLETED", "ERROR", "FAILED", "CANCELLED"];
    const isRunning = !completedStatuses.includes(
      state.status?.toUpperCase() || ""
    );

    return NextResponse.json({
      isRunning,
      phase: state.phase,
      status: state.status,
      iteration: state.iteration,
      lastUpdate: state.timestamp,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        isRunning: false,
        error: errorMessage,
      },
      { status: 500 }
    );
  }
}
