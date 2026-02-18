import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { stdout } = await execAsync("gh api user --jq '.login'");
    const login = stdout.trim();
    if (!login) {
      return Response.json(
        { error: "Could not determine GitHub user" },
        { status: 500 }
      );
    }
    return Response.json({ login });
  } catch (error) {
    console.error("[git/user] Error:", error);
    return Response.json(
      {
        error:
          "Failed to get GitHub user. Ensure gh is installed and authenticated.",
      },
      { status: 500 }
    );
  }
}
