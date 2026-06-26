import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import Busboy from "busboy";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { json } from "./response-utils.js";
import { assertRepoAllowed, resolveWorktreeDir } from "./symphony-utils.js";

const ALLOWED_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024;

const EXT_MAP: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

type UploadedFile = {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
};

export function registerSymphonyUploadRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[]
): void {
  dispatcher.register(
    "POST",
    "/api/gateway/symphony/upload/:ticketId",
    async (context) => {
      const ticketId = context.params.ticketId;
      const repoPath = context.query.get("repo");

      if (!repoPath) {
        json(context, 400, { error: "repo parameter is required" });
        return;
      }

      let expandedRepoPath: string;
      try {
        expandedRepoPath = assertRepoAllowed(repoPath, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }

      const worktreeDir = resolveWorktreeDir(expandedRepoPath, ticketId);
      if (!existsSync(worktreeDir)) {
        json(context, 404, { error: "Work directory not found" });
        return;
      }

      const attachmentsDir = path.join(
        worktreeDir,
        ".closedloop-ai",
        "work",
        "attachments"
      );
      try {
        assertPathAllowed(attachmentsDir, getAllowedDirectories());
      } catch (error) {
        if (error instanceof DirectoryNotAllowedError) {
          json(context, 403, { error: "directory not allowed" });
          return;
        }
        throw error;
      }
      await fs.mkdir(attachmentsDir, { recursive: true });

      const contentType = context.request.headers["content-type"];
      if (!contentType?.toLowerCase().includes("multipart/form-data")) {
        json(context, 400, { error: "Invalid form data" });
        return;
      }

      let files: UploadedFile[];
      try {
        files = await parseMultipartFiles(contentType, context.rawBody);
      } catch {
        json(context, 400, { error: "Invalid form data" });
        return;
      }

      if (files.length === 0) {
        json(context, 400, { error: "No image files provided" });
        return;
      }

      const savedFiles: Array<{
        originalName: string;
        savedName: string;
        path: string;
        apiUrl: string;
        size: number;
      }> = [];

      for (const file of files) {
        if (!ALLOWED_TYPES.has(file.mimeType)) {
          json(context, 400, {
            error: `File type not allowed: ${file.mimeType}. Allowed: png, jpeg, gif, webp`,
          });
          return;
        }

        if (file.size > MAX_FILE_SIZE) {
          json(context, 400, {
            error: `File too large: ${file.originalName} (${(
              file.size / 1024 / 1024
            ).toFixed(1)}MB). Max 10MB.`,
          });
          return;
        }

        const ext =
          EXT_MAP[file.mimeType] ?? path.extname(file.originalName) ?? ".png";
        const savedName = `chat-img-${Date.now()}-${crypto.randomBytes(2).toString("hex")}${ext}`;
        const savedPath = path.join(attachmentsDir, savedName);

        await fs.writeFile(savedPath, file.buffer);

        const apiUrl = `/api/gateway/symphony/attachments/${encodeURIComponent(
          ticketId
        )}/${encodeURIComponent(savedName)}?repo=${encodeURIComponent(repoPath)}`;
        savedFiles.push({
          originalName: file.originalName,
          savedName,
          path: savedPath,
          apiUrl,
          size: file.size,
        });
      }

      json(context, 200, { files: savedFiles });
    }
  );
}

async function parseMultipartFiles(
  contentType: string,
  body: Buffer
): Promise<UploadedFile[]> {
  return await new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: { "content-type": contentType } });
    const files: UploadedFile[] = [];
    const pending: Promise<void>[] = [];

    busboy.on(
      "file",
      (
        _fieldName: string,
        file: Readable,
        info: { filename: string; mimeType: string }
      ) => {
        const { filename, mimeType } = info;
        const chunks: Buffer[] = [];
        let size = 0;

        const done = new Promise<void>((resolveFile, rejectFile) => {
          file.on("data", (chunk: Buffer) => {
            size += chunk.length;
            chunks.push(chunk);
          });
          file.on("error", rejectFile);
          file.on("end", () => {
            files.push({
              originalName: filename || "file",
              mimeType,
              size,
              buffer: Buffer.concat(chunks),
            });
            resolveFile();
          });
        });

        pending.push(done);
      }
    );

    busboy.on("error", reject);
    busboy.on("finish", () => {
      Promise.all(pending)
        .then(() => resolve(files))
        .catch(reject);
    });

    busboy.end(body);
  });
}
