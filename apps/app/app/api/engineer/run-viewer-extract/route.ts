import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import JSZip from "jszip";
import { type NextRequest, NextResponse } from "next/server";

const PREFIX = "/tmp/run-viewer-";
const MAX_ZIP_SIZE = 200 * 1024 * 1024; // 200MB

function isValidRunDir(path: string): boolean {
  return path.startsWith(PREFIX) && !path.includes("..") && path.length < 200;
}

/** Filter out macOS junk files and directories from zip entries */
function isUsableEntry(name: string, entry: JSZip.JSZipObject): boolean {
  return !(
    entry.dir ||
    name.startsWith("__MACOSX/") ||
    name.endsWith("/.DS_Store") ||
    name.endsWith(".DS_Store")
  );
}

/** Strip common root prefix from a set of paths */
function stripCommonRoot(paths: string[]): {
  stripped: string[];
  prefixLen: number;
} {
  if (paths.length === 0) {
    return { stripped: paths, prefixLen: 0 };
  }

  const parts0 = paths[0].split("/");
  let commonDepth = 0;

  for (let d = 0; d < parts0.length - 1; d++) {
    const segment = parts0[d];
    if (paths.every((p) => p.split("/")[d] === segment)) {
      commonDepth = d + 1;
    } else {
      break;
    }
  }

  if (commonDepth === 0) {
    return { stripped: paths, prefixLen: 0 };
  }

  const prefix = parts0.slice(0, commonDepth).join("/");
  const prefixLen = prefix.length + 1;
  const stripped = paths
    .map((p) => p.slice(prefixLen))
    .filter((p) => p.length > 0);
  return { stripped, prefixLen };
}

/** Extract zip entries, handling nested zips (macOS zip-in-zip) */
async function extractEntries(
  zip: JSZip
): Promise<{ name: string; data: Uint8Array }[]> {
  const entries = Object.entries(zip.files).filter(([name, f]) =>
    isUsableEntry(name, f)
  );

  // Check for single nested zip
  if (entries.length === 1 && entries[0][0].endsWith(".zip")) {
    try {
      const innerData = await entries[0][1].async("uint8array");
      const innerZip = await JSZip.loadAsync(innerData);
      const innerEntries = Object.entries(innerZip.files).filter(([name, f]) =>
        isUsableEntry(name, f)
      );
      const result: { name: string; data: Uint8Array }[] = [];
      for (const [name, entry] of innerEntries) {
        result.push({ name, data: await entry.async("uint8array") });
      }
      return result;
    } catch {
      // Fall through to extract the outer zip normally
    }
  }

  const result: { name: string; data: Uint8Array }[] = [];
  for (const [name, entry] of entries) {
    result.push({ name, data: await entry.async("uint8array") });
  }
  return result;
}

/**
 * POST /api/run-viewer-extract
 *
 * Accepts a zip file as multipart/form-data, extracts to /tmp/run-viewer-<uuid>/.
 * Returns { runDir }.
 */
export async function POST(request: NextRequest) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "No zip file provided" },
      { status: 400 }
    );
  }

  if (file.size > MAX_ZIP_SIZE) {
    return NextResponse.json(
      { error: "Zip file too large (max 200MB)" },
      { status: 400 }
    );
  }

  const runDir = `${PREFIX}${randomUUID()}`;

  try {
    const arrayBuffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);
    const entries = await extractEntries(zip);

    if (entries.length === 0) {
      return NextResponse.json(
        { error: "Zip contains no files" },
        { status: 400 }
      );
    }

    // Strip common root prefix
    const names = entries.map((e) => e.name);
    const { prefixLen } = stripCommonRoot(names);

    mkdirSync(runDir, { recursive: true });
    writeEntriesToDisk(runDir, entries, prefixLen);

    console.log(
      `[run-viewer-extract] Extracted ${entries.length} files to ${runDir}`
    );
    return NextResponse.json({ runDir });
  } catch (err) {
    // Clean up on failure
    if (existsSync(runDir)) {
      rmSync(runDir, { recursive: true, force: true });
    }
    const message =
      err instanceof Error ? err.message : "Failed to extract zip";
    console.error("[run-viewer-extract] Error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/run-viewer-extract
 *
 * Accepts { runDir } JSON body. Cleans up the temp directory.
 */
export async function DELETE(request: NextRequest) {
  let body: { runDir?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { runDir } = body;
  if (!(runDir && isValidRunDir(runDir))) {
    return NextResponse.json({ error: "Invalid runDir" }, { status: 400 });
  }

  if (existsSync(runDir)) {
    rmSync(runDir, { recursive: true, force: true });
    console.log(`[run-viewer-extract] Cleaned up ${runDir}`);
  }

  return NextResponse.json({ success: true });
}

/**
 * GET /api/run-viewer-extract?runDir=...
 *
 * Returns a file listing for the extracted run directory.
 */
export function GET(request: NextRequest) {
  const runDir = request.nextUrl.searchParams.get("runDir");
  if (!(runDir && isValidRunDir(runDir))) {
    return NextResponse.json({ error: "Invalid runDir" }, { status: 400 });
  }

  if (!existsSync(runDir)) {
    return NextResponse.json(
      { error: "Run directory not found" },
      { status: 404 }
    );
  }

  const files: string[] = [];
  function walk(dir: string, prefix: string) {
    const items = readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(join(dir, item.name), rel);
      } else {
        files.push(rel);
      }
    }
  }
  walk(runDir, "");

  return NextResponse.json({ files });
}

function writeEntriesToDisk(
  runDir: string,
  entries: { name: string; data: Uint8Array }[],
  prefixLen: number
): void {
  for (const entry of entries) {
    const relativePath =
      prefixLen > 0 ? entry.name.slice(prefixLen) : entry.name;
    if (!relativePath) {
      continue;
    }

    const fullPath = join(runDir, relativePath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fullPath, Buffer.from(entry.data));
  }
}
