import { exec } from "node:child_process";
import { promisify } from "node:util";
import { NextResponse } from "next/server";

const execAsync = promisify(exec);

export type Commit = {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
  relativeDate: string;
};

export type VersionResponse = {
  version: string;
  commits: Commit[];
};

export async function GET() {
  try {
    // Get the short hash for the version badge
    const { stdout: versionOut } = await execAsync(
      "git rev-parse --short HEAD"
    );
    const version = versionOut.trim();

    // Get the last 10 commits with detailed info
    // Format: hash|shortHash|subject|body|author|date|relativeDate
    const format = "%H|%h|%s|%b|%an|%ci|%cr";
    const { stdout: logOut } = await execAsync(
      `git log -10 --pretty=format:"${format}---COMMIT_END---"`
    );

    const commits: Commit[] = logOut
      .split("---COMMIT_END---")
      .filter((entry) => entry.trim())
      .map((entry) => {
        const parts = entry.trim().split("|");
        return {
          hash: parts[0] ?? "",
          shortHash: parts[1] ?? "",
          subject: parts[2] ?? "",
          body: parts.slice(3, -3).join("|").trim(), // Body might contain |
          author: parts.at(-3) ?? "",
          date: parts.at(-2) ?? "",
          relativeDate: parts.at(-1) ?? "",
        };
      });

    return NextResponse.json({ version, commits } satisfies VersionResponse);
  } catch (error) {
    console.error("Failed to get version info:", error);
    return NextResponse.json(
      { error: "Failed to get version info" },
      { status: 500 }
    );
  }
}
