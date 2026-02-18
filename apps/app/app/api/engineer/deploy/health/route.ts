import { type NextRequest, NextResponse } from "next/server";

/**
 * API route to health-check a deployed URL
 *
 * POST /api/engineer/deploy/health
 * Body: { url }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = body as { url: string };

    if (!url) {
      return NextResponse.json({ error: "url is required" }, { status: 400 });
    }

    try {
      const response = await fetch(url, {
        method: "HEAD",
        signal: AbortSignal.timeout(10_000),
      });

      return NextResponse.json({
        alive: response.ok,
        statusCode: response.status,
      });
    } catch {
      return NextResponse.json({
        alive: false,
        statusCode: null,
      });
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Health check failed: ${errorMessage}` },
      { status: 500 }
    );
  }
}
