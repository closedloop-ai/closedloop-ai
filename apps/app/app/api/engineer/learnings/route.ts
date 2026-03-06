import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { parseToon } from "@/lib/engineer/toon-parser";

export async function GET() {
  try {
    const newPath = join(
      homedir(),
      ".closedloop-ai",
      "learnings",
      "org-patterns.toon"
    );
    const legacyPath = join(
      homedir(),
      ".claude",
      ".learnings",
      "org-patterns.toon"
    );
    const filePath = existsSync(newPath) ? newPath : legacyPath;
    const content = await readFile(filePath, "utf-8");
    const patterns = parseToon(content);

    return NextResponse.json({ patterns });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return NextResponse.json({ patterns: [] });
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      { error: `Failed to read learnings: ${message}` },
      { status: 500 }
    );
  }
}
