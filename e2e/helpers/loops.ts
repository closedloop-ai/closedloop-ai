import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type { APIRequestContext } from "@playwright/test";
import type { ApiResult } from "@repo/api/src/types/common";
import { EvalStatus, type JudgesReport } from "@repo/api/src/types/evaluation";
import {
  type CreateLoopResponse,
  type LoopCommand,
  type LoopStatus,
  type LoopWithUser,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { config } from "dotenv";
import { getApiBaseUrl } from "./api-url";

config({ path: "./apps/api/.env.local", override: false });

const LOOP_POLL_TIMEOUT_MS = 5000;
const LOOP_POLL_INTERVAL_MS = 500;
const require = createRequire(import.meta.url);
const { issueLoopRunnerToken } =
  require("@repo/auth/loop-runner-jwt") as typeof import("@repo/auth/loop-runner-jwt");

export function makeFeatureJudgesReport({
  metricName,
  justification,
  reportId = `feature-report-${randomUUID()}`,
}: {
  metricName: string;
  justification: string;
  reportId?: string;
}): JudgesReport {
  return {
    report_id: reportId,
    timestamp: new Date().toISOString(),
    stats: [
      {
        type: "case_score",
        case_id: `${metricName}-case`,
        final_status: EvalStatus.Passed,
        metrics: [
          {
            metric_name: metricName,
            threshold: 0.75,
            score: 0.92,
            justification,
          },
        ],
      },
    ],
  };
}

export async function createEvaluateFeatureLoop(
  request: APIRequestContext,
  {
    documentId,
    computeTargetId,
    token,
  }: {
    documentId: string;
    computeTargetId?: string;
    token: string;
  }
): Promise<CreateLoopResponse> {
  const api = getApiBaseUrl();
  const response = await request.post(
    `${api}/documents/${documentId}/run-loop`,
    {
      data: {
        command: RunLoopCommand.EvaluateFeature,
        ...(computeTargetId ? { computeTargetId } : {}),
      },
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  const body = (await response.json()) as ApiResult<CreateLoopResponse>;
  if (!body.success) {
    throw new Error(`Failed to create EVALUATE_FEATURE loop: ${body.error}`);
  }
  return body.data;
}

export async function countLoops(
  request: APIRequestContext,
  {
    documentId,
    command,
    token,
    timeoutMs = LOOP_POLL_TIMEOUT_MS,
  }: {
    documentId: string;
    command: LoopCommand;
    token: string;
    timeoutMs?: number;
  }
): Promise<number> {
  const api = getApiBaseUrl();
  const deadline = Date.now() + timeoutMs;
  let lastCount = 0;

  while (Date.now() < deadline) {
    const response = await request.get(
      `${api}/loops?documentId=${documentId}&command=${command}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (response.ok()) {
      const body = (await response.json()) as ApiResult<LoopWithUser[]>;
      if (body.success) {
        lastCount = body.data.length;
        if (lastCount > 0) {
          return lastCount;
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, LOOP_POLL_INTERVAL_MS));
  }

  return lastCount;
}

export async function getLatestLoop(
  request: APIRequestContext,
  {
    documentId,
    command,
    token,
  }: {
    documentId: string;
    command: LoopCommand;
    token: string;
  }
): Promise<LoopWithUser | null> {
  const api = getApiBaseUrl();
  const response = await request.get(
    `${api}/loops?documentId=${documentId}&command=${command}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const body = (await response.json()) as ApiResult<LoopWithUser[]>;
  if (!body.success) {
    throw new Error(`Failed to fetch loops: ${body.error}`);
  }
  return body.data[0] ?? null;
}

export async function completeFeatureEvaluationLoop(
  request: APIRequestContext,
  {
    loopId,
    organizationId,
    report,
  }: {
    loopId: string;
    organizationId: string;
    report: JudgesReport;
  }
): Promise<void> {
  const api = getApiBaseUrl();
  const runnerToken = await issueLoopRunnerToken({ loopId, organizationId });
  const runnerHeaders = {
    Authorization: `Bearer ${runnerToken}`,
  };

  await postLoopEvent(request, {
    loopId,
    headers: runnerHeaders,
    event: {
      type: "started",
      loopId,
      timestamp: new Date().toISOString(),
    },
  });

  const uploadResponse = await request.post(
    `${api}/loops/${loopId}/upload-artifacts`,
    {
      data: { artifacts: { featureJudges: report } },
      headers: runnerHeaders,
    }
  );
  if (!uploadResponse.ok()) {
    throw new Error(
      `Failed to upload feature judges: ${uploadResponse.status()} ${uploadResponse.statusText()}`
    );
  }

  await postLoopEvent(request, {
    loopId,
    headers: runnerHeaders,
    event: {
      type: "completed",
      loopId,
      result: { exitCode: 0, durationSeconds: 1 },
      tokensUsed: { input: 1, output: 1 },
      timestamp: new Date().toISOString(),
    },
  });
}

export async function waitForLoopStatus(
  request: APIRequestContext,
  {
    documentId,
    command,
    status,
    token,
    timeoutMs = 10_000,
  }: {
    documentId: string;
    command: LoopCommand;
    status: LoopStatus;
    token: string;
    timeoutMs?: number;
  }
): Promise<LoopWithUser> {
  const deadline = Date.now() + timeoutMs;
  let latest: LoopWithUser | null = null;
  while (Date.now() < deadline) {
    latest = await getLatestLoop(request, { documentId, command, token });
    if (latest?.status === status) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, LOOP_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out waiting for ${command} loop on ${documentId} to reach ${status}. Latest status: ${latest?.status ?? "none"}`
  );
}

async function postLoopEvent(
  request: APIRequestContext,
  {
    loopId,
    headers,
    event,
  }: {
    loopId: string;
    headers: Record<string, string>;
    event: Record<string, unknown>;
  }
): Promise<void> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/loops/${loopId}/events`, {
    data: event,
    headers: {
      ...headers,
      "x-loop-event-nonce": randomUUID(),
    },
  });
  if (!response.ok()) {
    throw new Error(
      `Failed to post loop event ${event.type}: ${response.status()} ${response.statusText()}`
    );
  }
}
