/**
 * E2E tests for feature evaluation.
 *
 * These tests exercise the user-visible `/features/:slug` action and the
 * server-side loop/evaluation ingestion path used by completed feature
 * evaluation runs.
 */
import { randomUUID } from "node:crypto";
import type { Page } from "@playwright/test";
import { ComputePreference } from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import {
  LoopCommand,
  LoopStatus,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { getClerkBearerToken } from "./helpers/clerk-token";
import {
  deleteComputeTarget,
  getComputePreference,
  registerComputeTarget,
  restoreComputePreference,
  setComputePreference,
} from "./helpers/compute-targets";
import { createProject, deleteProject } from "./helpers/create-project";
import { createTeam, deleteTeam } from "./helpers/create-team";
import { createDocument, deleteDocument } from "./helpers/documents";
import {
  completeFeatureEvaluationLoop,
  createEvaluateFeatureLoop,
  getLatestLoop,
  makeFeatureJudgesReport,
  waitForLoopStatus,
} from "./helpers/loops";
import { authenticateToApp } from "./helpers/sign-in";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_ACTIONS_BUTTON = /^actions$/i;
const RE_AGENT_EVALUATION_BUTTON = /agent evaluation/i;
const RE_AWAITING_JUDGES = /awaiting llm judges feedback/i;
const RE_EVALUATE_FEATURE_BUTTON = /evaluate feature/i;

async function openEvaluateFeatureAction(page: Page) {
  const actionsButton = page.getByRole("button", { name: RE_ACTIONS_BUTTON });
  await expect(actionsButton).toBeVisible({ timeout: 30_000 });
  await expect(actionsButton).toBeEnabled({ timeout: 10_000 });

  await actionsButton.click();

  const evaluateFeatureMenuItem = page.getByRole("menuitem", {
    name: RE_EVALUATE_FEATURE_BUTTON,
  });
  await expect(evaluateFeatureMenuItem).toBeVisible({ timeout: 10_000 });
  return evaluateFeatureMenuItem;
}

async function openAgentEvaluation(page: Page) {
  const evaluationButton = page.getByRole("button", {
    name: RE_AGENT_EVALUATION_BUTTON,
  });
  await expect(evaluationButton).toBeVisible({ timeout: 30_000 });
  await evaluationButton.click();
}

function createJudgeMetricName(prefix: string): string {
  return createUniqueName(prefix).replaceAll("-", "_");
}

test("Evaluate Feature dispatches evaluate_feature for the feature document", async ({
  page,
  request,
}) => {
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);

  const team = await createTeam(request, {
    name: createUniqueName("e2e-feature-eval"),
    token,
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-feature-eval"),
    teamIds: [team.id],
    token,
  });
  const feature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: createUniqueName("e2e-feature"),
    content: "Feature description for E2E feature-evaluation dispatch test.",
    token,
  });

  try {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    await page.route(`**/documents/${feature.id}/run-loop`, async (route) => {
      capturedUrl = route.request().url();
      capturedBody = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({
        body: JSON.stringify({
          success: true,
          data: {
            loopId: randomUUID(),
            status: LoopStatus.Pending,
          },
        }),
        contentType: "application/json",
        status: 200,
      });
    });

    await page.goto(`/features/${feature.slug}`);

    const evaluateFeatureMenuItem = await openEvaluateFeatureAction(page);
    await evaluateFeatureMenuItem.click();

    await expect
      .poll(() => capturedUrl, {
        message: "Expected the feature run-loop endpoint to be called",
      })
      .toContain(`/documents/${feature.id}/run-loop`);
    expect(capturedBody.command).toBe(RunLoopCommand.EvaluateFeature);
    expect(capturedBody).not.toHaveProperty("computeTargetId");
  } finally {
    await deleteDocument(request, feature.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
  }
});

test("Feature judge results refetch after evaluation completes", async ({
  page,
  request,
}) => {
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);

  const team = await createTeam(request, {
    name: createUniqueName("e2e-feature-eval"),
    token,
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-feature-eval"),
    teamIds: [team.id],
    token,
  });
  const feature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: createUniqueName("e2e-feature"),
    content: "Feature description for E2E feature judge refetch test.",
    token,
  });
  const previousPreference = await getComputePreference(request, token);
  const target = await registerComputeTarget(request, {
    machineName: createUniqueName("e2e-feature-target"),
    token,
  });

  try {
    await setComputePreference(request, {
      mode: ComputePreference.Local,
      computeTargetId: target.id,
      token,
    });

    await page.goto(`/features/${feature.slug}`);
    await openAgentEvaluation(page);
    await expect(page.getByText(RE_AWAITING_JUDGES)).toBeVisible({
      timeout: 30_000,
    });

    // Same POST shape as Evaluate Feature in the UI; reload so generation-status polling picks up the new loop.
    const createdLoop = await createEvaluateFeatureLoop(request, {
      documentId: feature.id,
      token,
    });
    await page.reload();
    await openAgentEvaluation(page);
    const loop = await getLatestLoop(request, {
      documentId: feature.id,
      command: LoopCommand.EvaluateFeature,
      token,
    });
    if (!loop) {
      throw new Error("Expected created feature evaluation loop to exist");
    }
    expect(loop.id).toBe(createdLoop.loopId);

    const metricName = createJudgeMetricName("feature-refetch-judge");
    await completeFeatureEvaluationLoop(request, {
      loopId: createdLoop.loopId,
      organizationId: loop.organizationId,
      report: makeFeatureJudgesReport({
        metricName,
        justification: "Seeded feature evaluation passed after UI dispatch.",
      }),
    });
    await waitForLoopStatus(request, {
      documentId: feature.id,
      command: LoopCommand.EvaluateFeature,
      status: LoopStatus.Completed,
      token,
    });

    await expect(page.getByText(metricName)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("1/1 judges accepted")).toBeVisible();
  } finally {
    await restoreComputePreference(request, previousPreference, token);
    await deleteDocument(request, feature.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
    await deleteComputeTarget(request, target.id, token);
  }
});
