import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import Busboy from "busboy";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";

const execFileAsync = promisify(execFile);
const PREFIX = path.join(os.tmpdir(), "run-viewer-");
const MAX_ZIP_SIZE = 200 * 1024 * 1024;

export function registerRunViewerExtractRoutes(
  dispatcher: OperationDispatcher
): void {
  dispatcher.register(
    "POST",
    "/api/gateway/run-viewer-extract",
    async (context) => {
      const contentType = context.request.headers["content-type"];
      if (!contentType?.toLowerCase().includes("multipart/form-data")) {
        json(context, 400, { error: "Invalid form data" });
        return;
      }

      let uploaded: { name: string; size: number; buffer: Buffer } | null =
        null;
      try {
        uploaded = await parseZipUpload(contentType, context.rawBody);
      } catch {
        json(context, 400, { error: "Invalid form data" });
        return;
      }

      if (!uploaded) {
        json(context, 400, { error: "No zip file provided" });
        return;
      }

      if (uploaded.size > MAX_ZIP_SIZE) {
        json(context, 400, { error: "Zip file too large (max 200MB)" });
        return;
      }

      const runDir = `${PREFIX}${randomUUID()}`;
      const zipPath = `${PREFIX}upload-${randomUUID()}.zip`;

      try {
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(zipPath, uploaded.buffer);
        await execFileAsync("unzip", ["-qq", zipPath, "-d", runDir]);

        const files = await listFiles(runDir);
        if (files.length === 0) {
          await fs.rm(runDir, { recursive: true, force: true });
          json(context, 400, { error: "Zip contains no files" });
          return;
        }

        json(context, 200, { runDir });
      } catch (error) {
        if (existsSync(runDir)) {
          await fs.rm(runDir, { recursive: true, force: true });
        }

        const message =
          error instanceof Error ? error.message : "Failed to extract zip";
        json(context, 500, { error: message });
      } finally {
        await fs.rm(zipPath, { force: true }).catch(() => undefined);
      }
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/run-viewer-extract",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const runDir = typeof body.runDir === "string" ? body.runDir : null;
      if (!(runDir && isValidRunDir(runDir))) {
        json(context, 400, { error: "Invalid runDir" });
        return;
      }

      if (existsSync(runDir)) {
        await fs.rm(runDir, { recursive: true, force: true });
      }

      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/run-viewer-extract",
    async (context) => {
      const runDir = context.query.get("runDir");
      if (!(runDir && isValidRunDir(runDir))) {
        json(context, 400, { error: "Invalid runDir" });
        return;
      }

      if (!existsSync(runDir)) {
        json(context, 404, { error: "Run directory not found" });
        return;
      }

      json(context, 200, { files: await listFiles(runDir) });
    }
  );
}

function isValidRunDir(runDir: string): boolean {
  if (runDir.includes("..") || runDir.length > 220) {
    return false;
  }

  const resolved = path.resolve(runDir);
  return resolved.startsWith(PREFIX);
}

async function listFiles(rootDir: string): Promise<string[]> {
  const files: string[] = [];

  const walk = async (currentDir: string, prefix = ""): Promise<void> => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "__MACOSX" || entry.name === ".DS_Store") {
        continue;
      }

      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const fullPath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath, relative);
      } else {
        files.push(relative);
      }
    }
  };

  await walk(rootDir, "");
  files.sort();
  return files;
}

async function parseZipUpload(
  contentType: string,
  body: Buffer
): Promise<{ name: string; size: number; buffer: Buffer } | null> {
  return await new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: { "content-type": contentType } });
    let uploaded: { name: string; size: number; buffer: Buffer } | null = null;
    const pending: Promise<void>[] = [];

    busboy.on(
      "file",
      (
        _fieldName: string,
        file: Readable,
        info: { filename: string; mimeType: string }
      ) => {
        if (uploaded || info.mimeType !== "application/zip") {
          file.resume();
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;

        const done = new Promise<void>((resolveFile, rejectFile) => {
          file.on("data", (chunk: Buffer) => {
            size += chunk.length;
            chunks.push(chunk);
          });
          file.on("error", rejectFile);
          file.on("end", () => {
            uploaded = {
              name: info.filename || "run.zip",
              size,
              buffer: Buffer.concat(chunks),
            };
            resolveFile();
          });
        });

        pending.push(done);
      }
    );

    busboy.on("error", reject);
    busboy.on("finish", () => {
      Promise.all(pending)
        .then(() => resolve(uploaded))
        .catch(reject);
    });

    busboy.end(body);
  });
}
