/**
 * E2E regression: trace comments use the real Electron preload → main IPC →
 * DB-host path. This catches structured-clone mistakes where main accidentally
 * sends Prisma callback functions across the utility-process boundary.
 *
 * Prerequisites:
 *   - The app must be built first: `pnpm -C apps/desktop build`
 *   - Run via: npx playwright test --config apps/desktop/playwright.config.ts
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { Server as SocketIoServer } from "socket.io";
import { gotoNav, launchDesktopApp } from "./helpers/desktop-app";

const LOCAL_TRACE_COMMENT_ID_RE = /^local-/;
const SESSIONS_TOTAL_UNAVAILABLE_RE = /TOTAL SESSIONS\s+Unavailable/;
const TOKENS_TOTAL_UNAVAILABLE_RE = /TOTAL TOKENS\s+Unavailable/;
const SESSIONS_TOTAL_VALUE_RE = /TOTAL SESSIONS\s+\d/;

type TraceCommentTarget = {
  type: "session" | "branch";
  id: string;
};

type TraceCommentDraft = {
  anchor: {
    traceId: string;
    turnId: string;
    row: number;
    selectedText: string;
    sourceText: string;
    startOffset: number;
    endOffset: number;
    sessionId?: string | null;
    actor?: {
      name: string | null;
      human: string | null;
    } | null;
  };
  body: string;
};

type TraceComment = TraceCommentDraft & {
  id: string;
  threadId: string;
  target: TraceCommentTarget;
  artifactId: string;
  surface: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  canEdit: boolean;
  canDelete: boolean;
  replies: TraceCommentReply[];
};

type TraceCommentReply = {
  id: string;
  threadId: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  editedAt: string | null;
  authorId: string;
  authorName: string | null;
  authorAvatarUrl: string | null;
  canEdit: boolean;
  canDelete: boolean;
};

// FEA-2718: the event-fragment transport was retired, so a parent-session sync
// either fully syncs or is rejected — there is no `pendingFragments` shape.
type DesktopAgentSessionsSyncResponse = { synced: true };

type DesktopWindow = Window & {
  desktopApi?: {
    agentSessionsApi?: {
      detail: (id: string) => Promise<unknown | null>;
    };
    traceCommentsApi?: {
      list: (target: TraceCommentTarget) => Promise<TraceComment[]>;
      create: (
        target: TraceCommentTarget,
        draft: TraceCommentDraft
      ) => Promise<TraceComment>;
      reply: (
        target: TraceCommentTarget,
        commentId: string,
        draft: { body: string }
      ) => Promise<TraceComment>;
      update: (
        target: TraceCommentTarget,
        commentId: string,
        update: { body: string }
      ) => Promise<TraceComment>;
      delete: (
        target: TraceCommentTarget,
        commentId: string
      ) => Promise<{ deleted: true }>;
    };
  };
};

test.describe("Trace comments IPC", () => {
  test("creates and lists local desktop trace comments through the real IPC path", async () => {
    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-trace-comments-e2e-",
      env: {
        CLOSEDLOOP_API_KEY: "",
        CL_AUTH_API_ORIGIN: "",
      },
    });

    try {
      const target: TraceCommentTarget = {
        type: "session",
        id: "trace-comments-e2e-session",
      };
      const draft: TraceCommentDraft = {
        anchor: {
          traceId: "trace-comments-e2e-trace",
          turnId: "trace-comments-e2e-turn",
          row: 7,
          selectedText: "selected local text",
          sourceText: "selected local text in a trace row",
          startOffset: 0,
          endOffset: 19,
          sessionId: target.id,
          actor: { name: "Codex", human: null },
        },
        body: "Desktop local trace comment from Playwright",
      };

      await gotoNav(page, "sessions");
      await expectSessionsViewHealthy(page);

      await expect
        .poll(
          () =>
            page.evaluate(async (target) => {
              const desktopApi = (window as DesktopWindow).desktopApi;
              if (!desktopApi?.traceCommentsApi) {
                return "missing";
              }
              try {
                await desktopApi.traceCommentsApi.list(target);
                return "ready";
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : String(error);
                if (
                  message.includes("No handler registered") ||
                  message.includes("local store is unavailable")
                ) {
                  return "registering";
                }
                throw error;
              }
            }, target),
          { timeout: 30_000 }
        )
        .toBe("ready");

      const result = await page.evaluate(
        async ({ target, draft }) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.traceCommentsApi) {
            throw new Error("traceCommentsApi unavailable");
          }

          const before = await desktopApi.traceCommentsApi.list(target);
          const created = await desktopApi.traceCommentsApi.create(
            target,
            draft
          );
          const replied = await desktopApi.traceCommentsApi.reply(
            target,
            created.id,
            { body: "Reply from the desktop IPC path" }
          );
          const afterReply = await desktopApi.traceCommentsApi.list(target);
          const updated = await desktopApi.traceCommentsApi.update(
            target,
            created.id,
            { body: "Edited local desktop trace comment from Playwright" }
          );
          const afterUpdate = await desktopApi.traceCommentsApi.list(target);
          const deleted = await desktopApi.traceCommentsApi.delete(
            target,
            created.id
          );
          const after = await desktopApi.traceCommentsApi.list(target);
          return {
            before,
            created,
            replied,
            afterReply,
            updated,
            afterUpdate,
            deleted,
            after,
          };
        },
        { target, draft }
      );

      expect(result.before).toEqual([]);
      expect(result.created.body).toBe(draft.body);
      expect(result.created.id).toMatch(LOCAL_TRACE_COMMENT_ID_RE);
      expect(result.created.canEdit).toBe(true);
      expect(result.created.canDelete).toBe(true);
      expect(result.replied.replies).toHaveLength(1);
      expect(result.replied.replies[0]).toMatchObject({
        body: "Reply from the desktop IPC path",
        canEdit: false,
        canDelete: false,
      });
      expect(result.afterReply[0]?.replies.map((reply) => reply.body)).toEqual([
        "Reply from the desktop IPC path",
      ]);
      expect(result.updated.body).toBe(
        "Edited local desktop trace comment from Playwright"
      );
      expect(result.afterUpdate.map((comment) => comment.body)).toContain(
        "Edited local desktop trace comment from Playwright"
      );
      expect(result.deleted).toEqual({ deleted: true });
      expect(result.after).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("syncs desktop trace comments through the configured cloud API", async () => {
    const target: TraceCommentTarget = {
      type: "session",
      id: "trace-comments-cloud-session",
    };
    const cloudComments = [
      makeTraceComment(target, {
        id: "cloud-comment-existing",
        threadId: "cloud-thread-existing",
        body: "Existing cloud trace comment",
        canDelete: true,
        canEdit: true,
      }),
    ];
    const requests: { method: string; url: string; body: unknown }[] = [];
    const computeTargetId = "11111111-1111-4111-8111-111111111111";
    const server = await startTraceCommentsApiServer({
      onRequest: (request) => requests.push(request),
      onCreate: (draft) =>
        makeTraceComment(target, {
          id: "cloud-comment-created",
          threadId: "cloud-thread-created",
          body: draft.body,
          anchor: draft.anchor,
        }),
      onDelete: (commentId) => {
        const index = cloudComments.findIndex(
          (comment) => comment.id === commentId
        );
        if (index >= 0) {
          cloudComments.splice(index, 1);
        }
        return { deleted: true };
      },
      onUpdate: (commentId, update) => {
        const index = cloudComments.findIndex(
          (comment) => comment.id === commentId
        );
        if (index < 0) {
          return {
            statusCode: 404,
            error: "Trace comment not found",
          };
        }
        cloudComments[index] = {
          ...cloudComments[index],
          body: update.body,
          editedAt: "2026-06-26T16:05:00.000Z",
          updatedAt: "2026-06-26T16:05:00.000Z",
        };
        return cloudComments[index];
      },
      list: () => cloudComments,
    });

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-trace-comments-cloud-e2e-",
      env: {
        CLOSEDLOOP_API_KEY: "sk_live_trace_comments_e2e",
        CL_AUTH_API_ORIGIN: server.origin,
      },
      beforeLaunch: (userDataDir) =>
        seedActiveProfileComputeTarget(userDataDir, {
          apiOrigin: server.origin,
          computeTargetId,
        }),
    });

    try {
      const draft: TraceCommentDraft = {
        anchor: {
          traceId: "trace-comments-cloud-trace",
          turnId: "trace-comments-cloud-turn",
          row: 12,
          selectedText: "cloud selected text",
          sourceText: "cloud selected text in a trace row",
          startOffset: 0,
          endOffset: 19,
          sessionId: target.id,
          actor: { name: "Codex", human: null },
        },
        body: "Desktop cloud upload from Playwright",
      };

      await gotoNav(page, "sessions");
      await expectSessionsViewHealthy(page);
      await waitForTraceCommentsApi(page, target);

      const listed = await page.evaluate((target) => {
        const desktopApi = (window as DesktopWindow).desktopApi;
        if (!desktopApi?.traceCommentsApi) {
          throw new Error("traceCommentsApi unavailable");
        }
        return desktopApi.traceCommentsApi.list(target);
      }, target);
      expect(listed.map((comment) => comment.body)).toContain(
        "Existing cloud trace comment"
      );
      expect(listed[0]?.canEdit).toBe(true);
      expect(listed[0]?.canDelete).toBe(true);

      const cloudUpdateResult = await page.evaluate(async (target) => {
        const desktopApi = (window as DesktopWindow).desktopApi;
        if (!desktopApi?.traceCommentsApi) {
          throw new Error("traceCommentsApi unavailable");
        }
        const updated = await desktopApi.traceCommentsApi.update(
          target,
          "cloud-comment-existing",
          { body: "Edited cloud trace comment from Desktop" }
        );
        const afterUpdate = await desktopApi.traceCommentsApi.list(target);
        return { afterUpdate, updated };
      }, target);

      expect(cloudUpdateResult.updated.body).toBe(
        "Edited cloud trace comment from Desktop"
      );
      expect(
        cloudUpdateResult.afterUpdate.map((comment) => comment.body)
      ).toContain("Edited cloud trace comment from Desktop");
      await expect
        .poll(
          () =>
            requests.some(
              (request) =>
                request.method === "PATCH" &&
                request.url.includes("/cloud-comment-existing")
            ),
          { timeout: 15_000 }
        )
        .toBe(true);

      const cloudDeleteResult = await page.evaluate(async (target) => {
        const desktopApi = (window as DesktopWindow).desktopApi;
        if (!desktopApi?.traceCommentsApi) {
          throw new Error("traceCommentsApi unavailable");
        }
        const deleted = await desktopApi.traceCommentsApi.delete(
          target,
          "cloud-comment-existing"
        );
        const afterDelete = await desktopApi.traceCommentsApi.list(target);
        return { afterDelete, deleted };
      }, target);

      expect(cloudDeleteResult.deleted).toEqual({ deleted: true });
      expect(
        cloudDeleteResult.afterDelete.map((comment) => comment.id)
      ).not.toContain("cloud-comment-existing");
      await expect
        .poll(
          () =>
            requests.some(
              (request) =>
                request.method === "DELETE" &&
                request.url.includes("/cloud-comment-existing")
            ),
          { timeout: 15_000 }
        )
        .toBe(true);

      const created = await page.evaluate(
        ({ target, draft }) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.traceCommentsApi) {
            throw new Error("traceCommentsApi unavailable");
          }
          return desktopApi.traceCommentsApi.create(target, draft);
        },
        { target, draft }
      );

      expect(created.body).toBe(draft.body);
      await expect
        .poll(
          () =>
            requests.filter(
              (request) =>
                request.method === "POST" &&
                hasTraceCommentsRequestUrl(request.url, {
                  path: "/agent-sessions/trace-comments-cloud-session/trace-comments",
                  computeTargetId,
                })
            ).length,
          { timeout: 15_000 }
        )
        .toBe(1);
      expect(
        requests.some(
          (request) =>
            request.method === "GET" &&
            hasTraceCommentsRequestUrl(request.url, {
              path: "/agent-sessions/trace-comments-cloud-session/trace-comments",
              computeTargetId,
            })
        )
      ).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      await server.close();
    }
  });

  test("syncs the parent cloud session before retrying a desktop comment after 404", async () => {
    const target: TraceCommentTarget = {
      type: "session",
      id: "trace-comments-missing-cloud-session",
    };
    const requests: { method: string; url: string; body: unknown }[] = [];
    const computeTargetId = "33333333-3333-4333-8333-333333333333";
    let helloAcked = false;
    let sessionSynced = false;
    const server = await startTraceCommentsApiServer({
      onRequest: (request) => requests.push(request),
      onSessionSync: (payload) => {
        const sessions = (
          payload as { sessions?: { externalSessionId: string }[] }
        ).sessions;
        // FEA-2718: the parent session arrives as one whole-session batch.
        sessionSynced =
          sessions?.some(
            (session) => session.externalSessionId === target.id
          ) === true;
        return { synced: true };
      },
      onCreate: (draft) =>
        makeTraceComment(target, {
          id: "cloud-comment-after-session-sync",
          threadId: "cloud-thread-after-session-sync",
          body: draft.body,
          anchor: draft.anchor,
        }),
      list: () => [],
      missingSession: () => !sessionSynced,
      onHello: () => {
        helloAcked = true;
      },
      helloAck: {
        computeTargetId,
        serverCapabilities: {
          agentSessionSync: true,
        },
      },
    });

    const { page, pageErrors, cleanup, userDataDir } = await launchDesktopApp({
      userDataPrefix: "desktop-trace-comments-session-sync-e2e-",
      env: {
        CLOSEDLOOP_API_KEY: "sk_live_trace_comments_e2e",
        CL_AUTH_API_ORIGIN: server.origin,
      },
      beforeLaunch: (userDataDir) => {
        seedActiveProfileComputeTarget(userDataDir, {
          apiOrigin: server.origin,
          computeTargetId,
          cloudConnectionEnabled: true,
          relayOrigin: server.origin,
        });
      },
    });

    try {
      const draft: TraceCommentDraft = {
        anchor: {
          traceId: "trace-comments-session-sync-trace",
          turnId: "trace-comments-session-sync-turn",
          row: 4,
          selectedText: "session sync selected text",
          sourceText: "session sync selected text in a trace row",
          startOffset: 0,
          endOffset: 26,
          sessionId: target.id,
          actor: { name: "Codex", human: null },
        },
        body: "Desktop upload after parent session sync",
      };

      await gotoNav(page, "sessions");
      await expectSessionsViewHealthy(page);
      await seedDesktopSessionSqlite(userDataDir, target.id);
      await waitForSeededSession(page, target.id);
      await waitForTraceCommentsBridge(page);
      await waitForTraceCommentsCloudConfig(page, requests);
      await expect.poll(() => helloAcked, { timeout: 15_000 }).toBe(true);

      await page.evaluate(
        async ({ target, draft }) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.traceCommentsApi) {
            throw new Error("traceCommentsApi unavailable");
          }
          await desktopApi.traceCommentsApi.create(target, draft);
        },
        { target, draft }
      );

      await expect
        .poll(
          () =>
            requests.some(
              (request) =>
                request.method === "POST" &&
                new URL(request.url, server.origin).pathname ===
                  "/desktop/agent-sessions/sync"
            ),
          { timeout: 15_000 }
        )
        .toBe(true);
      // FEA-2718: the parent session syncs as a single whole-session batch
      // (no fragmentation), so the cloud reports it synced.
      await expect.poll(() => sessionSynced, { timeout: 15_000 }).toBe(true);

      await expect
        .poll(
          () =>
            requests.filter(
              (request) =>
                request.method === "POST" &&
                hasTraceCommentsRequestUrl(request.url, {
                  path: "/agent-sessions/trace-comments-missing-cloud-session/trace-comments",
                  computeTargetId,
                })
            ).length,
          { timeout: 15_000 }
        )
        .toBe(1);

      const syncRequestIndexes = requests
        .map((request, index) =>
          request.method === "POST" &&
          new URL(request.url, server.origin).pathname ===
            "/desktop/agent-sessions/sync"
            ? index
            : -1
        )
        .filter((index) => index >= 0);
      const lastSyncRequestIndex = syncRequestIndexes.at(-1) ?? -1;
      const commentPostIndex = requests.findIndex(
        (request) =>
          request.method === "POST" &&
          hasTraceCommentsRequestUrl(request.url, {
            path: "/agent-sessions/trace-comments-missing-cloud-session/trace-comments",
            computeTargetId,
          })
      );
      expect(lastSyncRequestIndex).toBeGreaterThanOrEqual(0);
      expect(commentPostIndex).toBeGreaterThan(lastSyncRequestIndex);
      expect(sessionSynced).toBe(true);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      await server.close();
    }
  });

  test("retries failed desktop uploads in the background without relisting the target", async () => {
    const target: TraceCommentTarget = {
      type: "session",
      id: "trace-comments-background-retry-session",
    };
    const requests: { method: string; url: string; body: unknown }[] = [];
    const computeTargetId = "22222222-2222-4222-8222-222222222222";
    let uploadAttempts = 0;
    const server = await startTraceCommentsApiServer({
      onRequest: (request) => requests.push(request),
      onCreate: (draft) => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return {
            statusCode: 500,
            error: "temporary trace comment outage",
          };
        }
        return makeTraceComment(target, {
          id: "cloud-comment-retried",
          threadId: "cloud-thread-retried",
          body: draft.body,
          anchor: draft.anchor,
        });
      },
      list: () => [],
    });

    const { page, pageErrors, cleanup } = await launchDesktopApp({
      userDataPrefix: "desktop-trace-comments-retry-e2e-",
      env: {
        CLOSEDLOOP_API_KEY: "sk_live_trace_comments_e2e",
        CL_AUTH_API_ORIGIN: server.origin,
      },
      beforeLaunch: (userDataDir) =>
        seedActiveProfileComputeTarget(userDataDir, {
          apiOrigin: server.origin,
          computeTargetId,
        }),
    });

    try {
      const draft: TraceCommentDraft = {
        anchor: {
          traceId: "trace-comments-retry-trace",
          turnId: "trace-comments-retry-turn",
          row: 4,
          selectedText: "retry selected text",
          sourceText: "retry selected text in a trace row",
          startOffset: 0,
          endOffset: 19,
          sessionId: target.id,
          actor: { name: "Codex", human: null },
        },
        body: "Desktop background retry upload from Playwright",
      };

      await gotoNav(page, "sessions");
      await expectSessionsViewHealthy(page);
      await waitForTraceCommentsApi(page, target);

      await page.evaluate(
        async ({ target, draft }) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.traceCommentsApi) {
            throw new Error("traceCommentsApi unavailable");
          }
          await desktopApi.traceCommentsApi.create(target, draft);
        },
        { target, draft }
      );

      await expect
        .poll(() => uploadAttempts, { timeout: 15_000 })
        .toBeGreaterThanOrEqual(1);
      await expect
        .poll(() => uploadAttempts, { timeout: 35_000 })
        .toBeGreaterThanOrEqual(2);
      expect(
        requests.filter(
          (request) =>
            request.method === "POST" &&
            hasTraceCommentsRequestUrl(request.url, {
              path: "/agent-sessions/trace-comments-background-retry-session/trace-comments",
              computeTargetId,
            })
        )
      ).toHaveLength(2);
      expect(pageErrors).toEqual([]);
    } finally {
      await cleanup();
      await server.close();
    }
  });
});

async function waitForTraceCommentsApi(
  page: Page,
  target: TraceCommentTarget
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (target) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.traceCommentsApi) {
            return "missing";
          }
          try {
            await desktopApi.traceCommentsApi.list(target);
            return "ready";
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              message.includes("No handler registered") ||
              message.includes("local store is unavailable")
            ) {
              return "registering";
            }
            throw error;
          }
        }, target),
      { timeout: 30_000 }
    )
    .toBe("ready");
}

async function waitForTraceCommentsBridge(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          return desktopApi?.traceCommentsApi ? "ready" : "missing";
        }),
      { timeout: 30_000 }
    )
    .toBe("ready");
}

async function waitForSeededSession(
  page: Page,
  sessionId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async (id) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.agentSessionsApi) {
            return "missing";
          }
          try {
            const detail = await desktopApi.agentSessionsApi.detail(id);
            return detail ? "ready" : "loading";
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              message.includes("No handler registered") ||
              message.includes("local store is unavailable")
            ) {
              return "registering";
            }
            throw error;
          }
        }, sessionId),
      { timeout: 30_000 }
    )
    .toBe("ready");
}

async function waitForTraceCommentsCloudConfig(
  page: Page,
  requests: readonly { method: string; url: string; body: unknown }[]
): Promise<void> {
  const probeTarget: TraceCommentTarget = {
    type: "branch",
    id: "trace-comments-cloud-config-probe",
  };

  await expect
    .poll(
      async () => {
        const before = requests.length;
        const state = await page.evaluate(async (target) => {
          const desktopApi = (window as DesktopWindow).desktopApi;
          if (!desktopApi?.traceCommentsApi) {
            return "missing";
          }
          try {
            await desktopApi.traceCommentsApi.list(target);
            return "ready";
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (
              message.includes("No handler registered") ||
              message.includes("local store is unavailable")
            ) {
              return "registering";
            }
            throw error;
          }
        }, probeTarget);
        return state === "ready" && requests.length > before ? "ready" : state;
      },
      { timeout: 30_000 }
    )
    .toBe("ready");
}

async function expectSessionsViewHealthy(page: Page): Promise<void> {
  await expect(
    page.locator("header").getByText("Sessions", { exact: true })
  ).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const bodyText = await page.locator("body").innerText();
        if (
          bodyText.includes("Sessions are temporarily unavailable.") ||
          SESSIONS_TOTAL_UNAVAILABLE_RE.test(bodyText) ||
          TOKENS_TOTAL_UNAVAILABLE_RE.test(bodyText)
        ) {
          return "degraded";
        }
        if (
          bodyText.includes("No sessions found") ||
          SESSIONS_TOTAL_VALUE_RE.test(bodyText)
        ) {
          return "healthy";
        }
        return "loading";
      },
      { timeout: 30_000 }
    )
    .toBe("healthy");
}

function seedActiveProfileComputeTarget(
  userDataDir: string,
  options: {
    apiOrigin: string;
    cloudConnectionEnabled?: boolean;
    computeTargetId: string;
    relayOrigin?: string;
  }
): void {
  const settingsPath = path.join(userDataDir, "desktop-settings.json");
  const raw = fs.existsSync(settingsPath)
    ? JSON.parse(fs.readFileSync(settingsPath, "utf8"))
    : {};
  const relayOrigin = options.relayOrigin ?? "http://127.0.0.1:9";
  const webAppOrigin = "http://127.0.0.1:3000";
  fs.writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        ...raw,
        ...(options.cloudConnectionEnabled === undefined
          ? {}
          : { cloudConnectionEnabled: options.cloudConnectionEnabled }),
        // Main-process runtime APIs read these top-level origins, while the
        // Settings UI also mirrors them through the active saved profile.
        apiOrigin: options.apiOrigin,
        relayOrigin,
        webAppOrigin,
        activeConfigId: "trace-comments-e2e-profile",
        savedConfigs: [
          {
            id: "trace-comments-e2e-profile",
            name: "Trace Comments E2E",
            relayOrigin,
            apiOrigin: options.apiOrigin,
            webAppOrigin,
            lastComputeTargetId: options.computeTargetId,
          },
        ],
      },
      null,
      2
    ),
    "utf8"
  );
}

async function seedDesktopSessionSqlite(
  userDataDir: string,
  sessionId: string,
  options: { eventSafePayloadBytes?: number } = {}
): Promise<void> {
  const dbPath = path.join(userDataDir, "agent-dashboard.sqlite");
  await waitForSqliteSessionsTable(dbPath);
  const timestamp = "2026-06-26T16:00:00.000Z";
  const eventData =
    options.eventSafePayloadBytes === undefined
      ? null
      : JSON.stringify({
          index: 0,
          safePayload: "x".repeat(options.eventSafePayloadBytes),
        });
  const seedSql = `
        INSERT OR REPLACE INTO sessions
          (id, name, status, cwd, model, started_at, updated_at, ended_at,
           metadata, harness, billing_mode, data_revision, last_activity_at)
        VALUES
          (${sqlString(sessionId)}, 'Trace Comments E2E Session', 'completed',
           '/tmp/trace-comments-e2e', 'gpt-5', ${sqlString(timestamp)},
           ${sqlString(timestamp)}, ${sqlString(timestamp)}, '{}', 'codex',
           'api', 7, ${sqlString(timestamp)});
        ${
          eventData === null
            ? ""
            : `
        INSERT OR REPLACE INTO events
          (id, session_id, event_type, tool_name, summary, data, created_at)
        VALUES
          (${sqlString(`${sessionId}-event-oversized`)},
           ${sqlString(sessionId)}, 'ToolUse', 'Read',
           'Oversized trace-comment sync event', ${sqlString(eventData)},
           ${sqlString(timestamp)});
      `
        }
      `;
  execFileSync("sqlite3", [dbPath], { input: seedSql, stdio: "pipe" });
}

async function waitForSqliteSessionsTable(dbPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (fs.existsSync(dbPath)) {
      try {
        execFileSync("sqlite3", [dbPath, "SELECT 1 FROM sessions LIMIT 1;"], {
          stdio: "pipe",
        });
        return;
      } catch {
        // The DB host may still be applying migrations.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Timed out waiting for desktop SQLite sessions table.");
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function hasTraceCommentsRequestUrl(
  requestUrl: string,
  expected: { path: string; computeTargetId: string }
): boolean {
  const url = new URL(requestUrl, "http://127.0.0.1");
  return (
    url.pathname === expected.path &&
    url.searchParams.get("computeTargetId") === expected.computeTargetId
  );
}

function makeTraceComment(
  target: TraceCommentTarget,
  overrides: {
    id: string;
    threadId: string;
    body: string;
    anchor?: TraceCommentDraft["anchor"];
    canDelete?: boolean;
    canEdit?: boolean;
  }
): TraceComment {
  const createdAt = "2026-06-26T16:00:00.000Z";
  return {
    id: overrides.id,
    threadId: overrides.threadId,
    target,
    artifactId: "cloud-session-artifact",
    surface: "session_detail",
    status: "OPEN",
    createdAt,
    updatedAt: createdAt,
    editedAt: null,
    authorId: "cloud-user",
    authorName: "Cloud User",
    authorAvatarUrl: null,
    canEdit: overrides.canEdit ?? false,
    canDelete: overrides.canDelete ?? false,
    anchor:
      overrides.anchor ??
      ({
        traceId: "cloud-trace",
        turnId: "cloud-turn",
        row: 1,
        selectedText: "cloud text",
        sourceText: "cloud text in a trace row",
        startOffset: 0,
        endOffset: 10,
        sessionId: target.id,
        actor: { name: "Codex", human: null },
      } satisfies TraceCommentDraft["anchor"]),
    body: overrides.body,
    replies: [],
  };
}

type TraceCommentsApiServer = {
  origin: string;
  close: () => Promise<void>;
};

type TraceCommentsCreateResult =
  | TraceComment
  | {
      statusCode: number;
      error: string;
    };
type TraceCommentsUpdateResult = TraceCommentsCreateResult;

async function startTraceCommentsApiServer(options: {
  list: () => TraceComment[];
  onCreate: (draft: TraceCommentDraft) => TraceCommentsCreateResult;
  onDelete?: (commentId: string) => { deleted: true };
  onHello?: () => void;
  onSessionSync?: (
    payload: unknown
  ) => DesktopAgentSessionsSyncResponse | undefined;
  onUpdate?: (
    commentId: string,
    update: { body: string }
  ) => TraceCommentsUpdateResult;
  helloAck?: {
    computeTargetId: string;
    serverCapabilities?: Record<string, boolean>;
  };
  missingSession?: () => boolean;
  onRequest: (request: { method: string; url: string; body: unknown }) => void;
}): Promise<TraceCommentsApiServer> {
  const server = createServer(async (request, response) => {
    const body = await readJsonBody(request);
    options.onRequest({
      method: request.method ?? "GET",
      url: request.url ?? "/",
      body,
    });

    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      request.method === "POST" &&
      requestUrl.pathname === "/desktop/agent-sessions/sync"
    ) {
      const syncResult = options.onSessionSync?.(body) ?? { synced: true };
      writeJson(response, { success: true, data: syncResult });
      return;
    }

    if (options.missingSession?.()) {
      response.statusCode = 404;
      writeJson(response, { success: false, error: "Agent session not found" });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, { success: true, data: options.list() });
      return;
    }

    if (request.method === "POST") {
      const result = options.onCreate(body as TraceCommentDraft);
      if ("statusCode" in result) {
        response.statusCode = result.statusCode;
        writeJson(response, { success: false, error: result.error });
        return;
      }
      writeJson(response, {
        success: true,
        data: result,
      });
      return;
    }

    if (request.method === "PATCH") {
      const result = options.onUpdate?.(
        decodeURIComponent(requestUrl.pathname.split("/").at(-1) ?? ""),
        body as { body: string }
      );
      if (!result) {
        response.statusCode = 405;
        writeJson(response, { success: false, error: "Method not allowed" });
        return;
      }
      if ("statusCode" in result) {
        response.statusCode = result.statusCode;
        writeJson(response, { success: false, error: result.error });
        return;
      }
      writeJson(response, { success: true, data: result });
      return;
    }

    if (request.method === "DELETE") {
      const result = options.onDelete?.(
        decodeURIComponent(requestUrl.pathname.split("/").at(-1) ?? "")
      );
      if (!result) {
        response.statusCode = 405;
        writeJson(response, { success: false, error: "Method not allowed" });
        return;
      }
      writeJson(response, { success: true, data: result });
      return;
    }

    response.statusCode = 405;
    writeJson(response, { success: false, error: "Method not allowed" });
  });
  const socketServer = options.helloAck
    ? startTraceCommentsRelaySocketServer(server, {
        helloAck: options.helloAck,
        onHello: options.onHello,
      })
    : null;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Trace comments API server did not bind to a TCP port.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      socketServer?.close();
      await closeServer(server);
    },
  };
}

function startTraceCommentsRelaySocketServer(
  server: Server,
  options: {
    helloAck: {
      computeTargetId: string;
      serverCapabilities?: Record<string, boolean>;
    };
    onHello?: () => void;
  }
): SocketIoServer {
  const socketServer = new SocketIoServer(server, { serveClient: false });
  socketServer.of("/desktop-gateway").on("connection", (socket) => {
    socket.on("desktop.hello", () => {
      options.onHello?.();
      socket.emit("desktop.hello.ack", {
        computeTargetId: options.helloAck.computeTargetId,
        serverCapabilities: options.helloAck.serverCapabilities,
        serverTime: new Date().toISOString(),
        sessionId: "trace-comments-e2e-gateway-session",
      });
    });
    socket.on("desktop.presence", () => {});
  });
  return socketServer;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!(request.method === "POST" || request.method === "PATCH")) {
    return null;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : null;
}

function writeJson(response: ServerResponse, payload: unknown): void {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(payload));
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}
