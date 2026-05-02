/**
 * E2E tests for feature evaluation.
 *
 * These tests exercise the user-visible `/features/:slug` action and the
 * server-side loop/evaluation ingestion path used by completed feature
 * evaluation runs.
 */
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import { LinkType } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { ComputePreference } from "@repo/api/src/types/compute-target";
import { DocumentType } from "@repo/api/src/types/document";
import {
  type CreateLoopResponse,
  LoopCommand,
  LoopStatus,
  RunLoopCommand,
} from "@repo/api/src/types/loop";
import { createArtifactLink } from "./helpers/artifact-links";
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
  countLoops,
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
const RE_EVALUATING_FEATURE_BUTTON = /evaluating feature/i;
const RE_MULTI_TARGET_SELECTOR = /multiple compute targets are online/i;
const RE_SCORE_92 = /score: 92%/i;
const PROJECT_ARTIFACT_COLUMNS_VISIBILITY_KEY =
  "table:columns:project-artifacts";

function getDocumentRowByTitle(page: Page, title: string) {
  return page
    .getByText(title, { exact: true })
    .locator("xpath=ancestor::div[contains(@class, 'group/row')][1]");
}

function getScoreCell(row: Locator) {
  return row.locator(":scope > div").nth(6);
}

async function showProjectArtifactScoreColumn(page: Page) {
  await page.addInitScript(
    ({ storageKey }) => {
      try {
        localStorage.setItem(
          storageKey,
          JSON.stringify({
            type: true,
            parent: true,
            dueDate: true,
            assignee: true,
            priority: true,
            score: true,
            loop: true,
            updated: true,
            project: true,
          })
        );
      } catch {
        // Some auth or extension frames may not expose localStorage.
      }
    },
    { storageKey: PROJECT_ARTIFACT_COLUMNS_VISIBILITY_KEY }
  );
}

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

function parseRunLoopResponseBody(
  body: unknown,
  context: string
): CreateLoopResponse {
  const result = body as ApiResult<CreateLoopResponse>;
  if (!result.success) {
    throw new Error(`${context}: ${result.error}`);
  }
  return result.data;
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

test("Evaluate Feature shows pending menu state while request is in flight", async ({
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
    content: "Feature description for E2E feature-evaluation pending UI test.",
    token,
  });

  let releasePendingResponse = () => {};
  const pendingResponse = new Promise<void>((resolve) => {
    releasePendingResponse = resolve;
  });

  try {
    await page.route(`**/documents/${feature.id}/run-loop`, async (route) => {
      await pendingResponse;
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

    const actionsButton = page.getByRole("button", { name: RE_ACTIONS_BUTTON });
    await expect(actionsButton).toBeVisible();
    await actionsButton.click();

    const evaluatingMenuItem = page.getByRole("menuitem", {
      name: RE_EVALUATING_FEATURE_BUTTON,
    });
    await expect(evaluatingMenuItem).toBeVisible({ timeout: 10_000 });
    await expect(evaluatingMenuItem).toHaveAttribute("data-disabled", "");

    releasePendingResponse?.();
  } finally {
    releasePendingResponse?.();
    await deleteDocument(request, feature.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
  }
});

test("Feature judge results render on initial load", async ({
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
    content: "Feature description for seeded E2E feature judge feedback.",
    token,
  });
  const target = await registerComputeTarget(request, {
    machineName: createUniqueName("e2e-feature-target"),
    token,
  });

  try {
    const createdLoop = await createEvaluateFeatureLoop(request, {
      documentId: feature.id,
      computeTargetId: target.id,
      token,
    });
    const loop = await getLatestLoop(request, {
      documentId: feature.id,
      command: LoopCommand.EvaluateFeature,
      token,
    });
    if (!loop) {
      throw new Error("Expected created feature evaluation loop to exist");
    }
    expect(loop.id).toBe(createdLoop.loopId);

    const metricName = createJudgeMetricName("feature-initial-judge");
    await completeFeatureEvaluationLoop(request, {
      loopId: createdLoop.loopId,
      organizationId: loop.organizationId,
      report: makeFeatureJudgesReport({
        metricName,
        justification: "Seeded feature evaluation passed for initial load.",
      }),
    });
    await waitForLoopStatus(request, {
      documentId: feature.id,
      command: LoopCommand.EvaluateFeature,
      status: LoopStatus.Completed,
      token,
    });

    await page.goto(`/features/${feature.slug}`);
    await openAgentEvaluation(page);

    await expect(page.getByText(metricName)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("1/1 judges accepted")).toBeVisible();
    await expect(page.getByText(RE_SCORE_92)).toBeVisible();
    await expect(page.getByText(RE_AWAITING_JUDGES)).not.toBeVisible();
  } finally {
    await deleteDocument(request, feature.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
    await deleteComputeTarget(request, target.id, token);
  }
});

test("Feature evaluation score appears in the project Score column", async ({
  page,
  request,
}) => {
  await showProjectArtifactScoreColumn(page);
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);

  const team = await createTeam(request, {
    name: createUniqueName("e2e-feature-score"),
    token,
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-feature-score"),
    teamIds: [team.id],
    token,
  });
  const scoredFeatureTitle = createUniqueName("e2e-scored-feature");
  const scoredFeature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: scoredFeatureTitle,
    content: "Feature description for E2E project score column test.",
    token,
  });
  const emptyFeatureTitle = createUniqueName("e2e-unscored-feature");
  const emptyFeature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: emptyFeatureTitle,
    content: "Feature description without judge feedback.",
    token,
  });
  const target = await registerComputeTarget(request, {
    machineName: createUniqueName("e2e-feature-score-target"),
    token,
  });

  try {
    const createdLoop = await createEvaluateFeatureLoop(request, {
      documentId: scoredFeature.id,
      computeTargetId: target.id,
      token,
    });
    const loop = await getLatestLoop(request, {
      documentId: scoredFeature.id,
      command: LoopCommand.EvaluateFeature,
      token,
    });
    if (!loop) {
      throw new Error("Expected created feature evaluation loop to exist");
    }
    expect(loop.id).toBe(createdLoop.loopId);

    await completeFeatureEvaluationLoop(request, {
      loopId: createdLoop.loopId,
      organizationId: loop.organizationId,
      report: makeFeatureJudgesReport({
        metricName: createJudgeMetricName("feature-score-column-judge"),
        justification: "Seeded feature evaluation passed for score column.",
      }),
    });
    await waitForLoopStatus(request, {
      documentId: scoredFeature.id,
      command: LoopCommand.EvaluateFeature,
      status: LoopStatus.Completed,
      token,
    });

    await page.goto(`/teams/${team.id}/projects/${project.id}`);

    const scoredFeatureRow = getDocumentRowByTitle(page, scoredFeatureTitle);
    await expect(scoredFeatureRow).toBeVisible({ timeout: 30_000 });
    await expect(getScoreCell(scoredFeatureRow)).toHaveText("92%", {
      timeout: 30_000,
    });

    const emptyFeatureRow = getDocumentRowByTitle(page, emptyFeatureTitle);
    await expect(emptyFeatureRow).toBeVisible();
    await expect(getScoreCell(emptyFeatureRow)).toHaveText("\u2014");
  } finally {
    await deleteDocument(request, emptyFeature.id, token);
    await deleteDocument(request, scoredFeature.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
    await deleteComputeTarget(request, target.id, token);
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

    const runLoopResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/documents/${feature.id}/run-loop`),
      { timeout: 15_000 }
    );
    const evaluateFeatureMenuItem = await openEvaluateFeatureAction(page);
    await evaluateFeatureMenuItem.click();

    const runLoopResponse = await runLoopResponsePromise;
    const createdLoop = parseRunLoopResponseBody(
      await runLoopResponse.json(),
      "Feature evaluation run-loop failed"
    );
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

test("Evaluate Feature does not create PRD or plan evaluation side effects", async ({
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
  const prd = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Prd,
    title: createUniqueName("e2e-source-prd"),
    content: "Source PRD content for feature-evaluation side effect test.",
    token,
  });
  const feature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: createUniqueName("e2e-feature"),
    content: "Feature description for E2E side-effect isolation test.",
    token,
  });
  const plan = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.ImplementationPlan,
    title: createUniqueName("e2e-plan"),
    content:
      "Implementation plan content for feature-evaluation side effect test.",
    token,
  });

  try {
    await createArtifactLink(request, {
      sourceId: prd.id,
      targetId: feature.id,
      linkType: LinkType.Produces,
      token,
    });
    await createArtifactLink(request, {
      sourceId: feature.id,
      targetId: plan.id,
      linkType: LinkType.Produces,
      token,
    });

    await page.goto(`/features/${feature.slug}`);

    const runLoopResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/documents/${feature.id}/run-loop`),
      { timeout: 15_000 }
    );
    const evaluateFeatureMenuItem = await openEvaluateFeatureAction(page);
    await evaluateFeatureMenuItem.click();
    await runLoopResponsePromise;

    expect(
      await countLoops(request, {
        documentId: prd.id,
        command: LoopCommand.EvaluatePrd,
        token,
      })
    ).toBe(0);
    expect(
      await countLoops(request, {
        documentId: plan.id,
        command: LoopCommand.EvaluatePlan,
        token,
      })
    ).toBe(0);
    expect(
      await countLoops(request, {
        documentId: feature.id,
        command: LoopCommand.EvaluateFeature,
        token,
      })
    ).toBe(1);
  } finally {
    await deleteDocument(request, plan.id, token);
    await deleteDocument(request, feature.id, token);
    await deleteDocument(request, prd.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
  }
});

test("Evaluate Feature uses the preferred local target without showing a selector", async ({
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
    content: "Feature description for E2E local compute target test.",
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

    const runLoopResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`/documents/${feature.id}/run-loop`),
      { timeout: 15_000 }
    );
    const evaluateFeatureMenuItem = await openEvaluateFeatureAction(page);
    await evaluateFeatureMenuItem.click();

    const runLoopResponse = await runLoopResponsePromise;
    parseRunLoopResponseBody(
      await runLoopResponse.json(),
      "Feature evaluation run-loop failed"
    );

    await expect(page.getByText(RE_MULTI_TARGET_SELECTOR)).not.toBeVisible();
    const loop = await getLatestLoop(request, {
      documentId: feature.id,
      command: LoopCommand.EvaluateFeature,
      token,
    });
    expect(loop?.computeTargetId).toBe(target.id);
  } finally {
    await restoreComputePreference(request, previousPreference, token);
    await deleteDocument(request, feature.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
    await deleteComputeTarget(request, target.id, token);
  }
});
