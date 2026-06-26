import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OperationDispatcher } from "../operation-dispatcher.js";
import { assertPathAllowed, DirectoryNotAllowedError } from "../security.js";
import { parseBody } from "./parse-body.js";
import { json } from "./response-utils.js";
import {
  chatHistoryFilename,
  expandHome,
  VALID_PROVIDERS,
} from "./symphony-utils.js";

type ActiveSession = {
  ticketId: string;
  repoPath: string;
  worktreePath: string;
  pid?: number;
  contextRepoPaths?: string[];
  baseBranch?: string;
  parentTicketId?: string;
  loopId?: string;
  artifactId?: string;
  startedAt: string;
  lastAccessedAt: string;
};

type SessionsConfig = {
  sessions: ActiveSession[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseSessionBody(body: Record<string, unknown>): {
  ticketId: string | null;
  repoPath: string | null;
  worktreePath: string | null;
  pid: number | undefined;
  contextRepoPaths: string[] | undefined;
  baseBranch: string | undefined;
  parentTicketId: string | undefined;
  loopId: string | undefined;
  artifactId: string | undefined;
} {
  return {
    ticketId: asString(body.ticketId),
    repoPath: asString(body.repoPath),
    worktreePath: asString(body.worktreePath),
    pid: typeof body.pid === "number" ? body.pid : undefined,
    contextRepoPaths:
      Array.isArray(body.contextRepoPaths) &&
      body.contextRepoPaths.every((item) => typeof item === "string")
        ? body.contextRepoPaths
        : undefined,
    baseBranch: asString(body.baseBranch) ?? undefined,
    parentTicketId: asString(body.parentTicketId) ?? undefined,
    loopId: asString(body.loopId) ?? undefined,
    artifactId: asString(body.artifactId) ?? undefined,
  };
}

function upsertSession(
  config: SessionsConfig,
  fields: {
    ticketId: string;
    repoPath: string;
    worktreePath: string;
    pid?: number;
    contextRepoPaths?: string[];
    baseBranch?: string;
    parentTicketId?: string;
    loopId?: string;
    artifactId?: string;
  }
): void {
  const now = new Date().toISOString();
  const optionals = {
    ...(fields.pid !== undefined && { pid: fields.pid }),
    ...(fields.contextRepoPaths !== undefined && {
      contextRepoPaths: fields.contextRepoPaths,
    }),
    ...(fields.baseBranch !== undefined && { baseBranch: fields.baseBranch }),
    ...(fields.parentTicketId !== undefined && {
      parentTicketId: fields.parentTicketId,
    }),
    ...(fields.loopId !== undefined && { loopId: fields.loopId }),
    ...(fields.artifactId !== undefined && { artifactId: fields.artifactId }),
  };
  const existingIndex = config.sessions.findIndex(
    (session) => session.ticketId === fields.ticketId
  );

  if (existingIndex >= 0) {
    config.sessions[existingIndex] = {
      ...config.sessions[existingIndex],
      repoPath: fields.repoPath,
      worktreePath: fields.worktreePath,
      ...optionals,
      lastAccessedAt: now,
    };
  } else {
    config.sessions.push({
      ticketId: fields.ticketId,
      repoPath: fields.repoPath,
      worktreePath: fields.worktreePath,
      ...optionals,
      startedAt: now,
      lastAccessedAt: now,
    });
  }
}

export function registerSymphonySessionRoutes(
  dispatcher: OperationDispatcher,
  getAllowedDirectories: () => string[],
  getSymphonyDir: () => string
): void {
  dispatcher.register(
    "GET",
    "/api/gateway/symphony/sessions/unread-count",
    async (context) => {
      const dir = getSymphonyDir();
      const config = await loadSessions(dir);

      let count = 0;
      for (const session of config.sessions) {
        const worktreePath = expandHome(session.worktreePath);
        if (!existsSync(worktreePath)) {
          continue;
        }
        const workDir = path.join(worktreePath, ".closedloop-ai", "work");
        const candidates = [
          chatHistoryFilename(),
          ...[...VALID_PROVIDERS].map((p) => chatHistoryFilename(p)),
        ];
        const chatPath = candidates
          .map((f) => path.join(workDir, f))
          .find((p) => existsSync(p));
        if (!chatPath) {
          continue;
        }
        try {
          const raw = await fs.readFile(chatPath, "utf-8");
          const history = JSON.parse(raw) as { messages?: { role: string }[] };
          if (history.messages?.at(-1)?.role === "assistant") {
            count++;
          }
        } catch {
          // Corrupt or unreadable chat history — skip
        }
      }

      json(context, 200, { count });
    }
  );

  dispatcher.register(
    "GET",
    "/api/gateway/symphony/sessions",
    async (context) => {
      const dir = getSymphonyDir();
      const config = await loadSessions(dir);

      const validSessions = config.sessions.filter((session) => {
        const expandedWorktreePath = expandHome(session.worktreePath);
        return existsSync(expandedWorktreePath);
      });

      if (validSessions.length !== config.sessions.length) {
        await saveSessions(dir, { sessions: validSessions });
      }

      json(context, 200, { sessions: validSessions });
    }
  );

  dispatcher.register(
    "POST",
    "/api/gateway/symphony/sessions",
    async (context) => {
      const body = parseBody(context);
      if (!body) {
        json(context, 400, { error: "Invalid JSON body" });
        return;
      }

      const fields = parseSessionBody(body);

      if (!(fields.ticketId && fields.repoPath && fields.worktreePath)) {
        json(context, 400, {
          error: "ticketId, repoPath, and worktreePath are required",
        });
        return;
      }

      const pathsToCheck = [
        fields.repoPath,
        fields.worktreePath,
        ...(fields.contextRepoPaths ?? []),
      ];
      const pathError = assertAllPathsAllowed(
        pathsToCheck,
        getAllowedDirectories()
      );
      if (pathError) {
        json(context, pathError.status, { error: pathError.error });
        return;
      }

      const dir = getSymphonyDir();
      const config = await loadSessions(dir);
      upsertSession(config, {
        ticketId: fields.ticketId,
        repoPath: fields.repoPath,
        worktreePath: fields.worktreePath,
        pid: fields.pid,
        contextRepoPaths: fields.contextRepoPaths,
        baseBranch: fields.baseBranch,
        parentTicketId: fields.parentTicketId,
        loopId: fields.loopId,
        artifactId: fields.artifactId,
      });

      await saveSessions(dir, config);
      json(context, 200, { success: true });
    }
  );

  dispatcher.register(
    "DELETE",
    "/api/gateway/symphony/sessions",
    async (context) => {
      const ticketId = context.query.get("ticketId");
      if (!ticketId) {
        json(context, 400, { error: "ticketId parameter is required" });
        return;
      }

      const dir = getSymphonyDir();
      const config = await loadSessions(dir);
      config.sessions = config.sessions.filter(
        (session) => session.ticketId !== ticketId
      );
      await saveSessions(dir, config);
      json(context, 200, { success: true });
    }
  );
}

function assertAllPathsAllowed(
  paths: string[],
  allowedDirectories: string[]
): { error: string; status: 403 } | null {
  try {
    for (const p of paths) {
      assertPathAllowed(expandHome(p), allowedDirectories);
    }
    return null;
  } catch (error) {
    if (error instanceof DirectoryNotAllowedError) {
      return { error: "directory not allowed", status: 403 };
    }
    throw error;
  }
}

async function ensureDir(symphonyDir: string): Promise<void> {
  await fs.mkdir(symphonyDir, { recursive: true });
}

async function loadSessions(symphonyDir: string): Promise<SessionsConfig> {
  await ensureDir(symphonyDir);
  const sessionsFile = getSessionsFile(symphonyDir);

  if (!existsSync(sessionsFile)) {
    return { sessions: [] };
  }

  try {
    const content = await fs.readFile(sessionsFile, "utf-8");
    const parsed = JSON.parse(content) as SessionsConfig;
    if (!Array.isArray(parsed.sessions)) {
      return { sessions: [] };
    }
    return parsed;
  } catch {
    return { sessions: [] };
  }
}

async function saveSessions(
  symphonyDir: string,
  config: SessionsConfig
): Promise<void> {
  await ensureDir(symphonyDir);
  await fs.writeFile(
    getSessionsFile(symphonyDir),
    JSON.stringify(config, null, 2),
    "utf-8"
  );
}

function getSessionsFile(symphonyDir: string): string {
  return path.join(symphonyDir, "sessions.json");
}
