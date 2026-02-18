import { type NextRequest, NextResponse } from "next/server";

/**
 * API route to kill a deploy process
 *
 * POST /api/deploy/kill
 * Body: { pid: number }
 *
 * Same SIGTERM→SIGKILL pattern as /api/symphony/kill
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { pid } = body as { pid: number };

    if (!pid || typeof pid !== "number") {
      return NextResponse.json(
        { error: "pid is required and must be a number" },
        { status: 400 }
      );
    }

    // Check if process exists
    try {
      process.kill(pid, 0);
    } catch {
      return NextResponse.json({
        success: true,
        message: "Process already terminated",
        pid,
      });
    }

    // Kill the process group
    try {
      process.kill(-pid, "SIGTERM");

      await new Promise((resolve) => setTimeout(resolve, 500));

      // Check if still alive and force kill
      try {
        process.kill(pid, 0);
        process.kill(-pid, "SIGKILL");
      } catch {
        // Process is dead
      }

      return NextResponse.json({
        success: true,
        message: "Process terminated",
        pid,
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : "Unknown error";

      if (errorMessage.includes("ESRCH")) {
        return NextResponse.json({
          success: true,
          message: "Process already terminated",
          pid,
        });
      }

      return NextResponse.json(
        { error: `Failed to kill process: ${errorMessage}` },
        { status: 500 }
      );
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to process kill request: ${errorMessage}` },
      { status: 500 }
    );
  }
}
