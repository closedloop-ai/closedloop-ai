/**
 * E2E tests for PLN-442: plan generation and PRD evaluation run-loop routing.
 *
 * Test 1 (regression guard): When a user clicks "Generate Plan" on a Feature
 * document and submits the NewPlanModal, the run-loop endpoint must be called
 * with command="plan" only. An evaluate_prd command must never be dispatched as
 * a side effect of plan generation on a Feature.
 *
 * Test 2 (positive case): When a user clicks "Evaluate PRD" on a PRD document,
 * the run-loop endpoint must be called with command="evaluate_prd".
 */
import type { APIRequestContext, Page } from "@playwright/test";
import type { ApiResult } from "@repo/api/src/types/common";
import { getApiBaseUrl } from "./helpers/api-url";
import { createProject } from "./helpers/create-project";
import { createTeam } from "./helpers/create-team";
import { authenticateToApp } from "./helpers/sign-in";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_GENERATE_PLAN_MODAL_TITLE = /generate implementation plan/i;
const RE_GENERATE_PLAN_BUTTON = /generate plan/i;
const RE_PLAN_TITLE_INPUT = /title/i;
const RE_ACTIONS_BUTTON = /^actions$/i;
const RE_EVALUATE_PRD_BUTTON = /evaluate prd/i;

type DocumentSummary = {
  id: string;
  slug: string;
  title: string;
};

/**
 * Creates a document via the API with the given type and content.
 */
async function createDocument(
  request: APIRequestContext,
  {
    projectId,
    type,
    title,
    content,
  }: {
    projectId: string;
    type: string;
    title: string;
    content: string;
  }
): Promise<DocumentSummary> {
  const api = getApiBaseUrl();
  const response = await request.post(`${api}/documents`, {
    data: { projectId, type, title, content },
  });
  const body = (await response.json()) as ApiResult<DocumentSummary>;

  if (!body.success) {
    throw new Error(`Failed to create ${type} document: ${body.error}`);
  }

  const { id, slug } = body.data;
  return { id, slug, title: body.data.title };
}

/**
 * Deletes a document by ID via the API. Used for cleanup.
 */
async function deleteDocument(
  request: APIRequestContext,
  documentId: string
): Promise<void> {
  const api = getApiBaseUrl();
  try {
    const response = await request.delete(`${api}/documents/${documentId}`);
    if (!response.ok()) {
      console.error({
        documentId,
        status: response.status(),
        statusText: response.statusText(),
      });
    }
  } catch {
    console.error({ documentId, status: 0, statusText: "request failed" });
  }
}

/**
 * Installs a request listener that captures run-loop POST requests containing
 * "evaluate_prd" in the body. Returns the captured entries array.
 */
function captureEvaluatePrdRequests(page: Page): string[] {
  const captured: string[] = [];

  page.on("request", (req) => {
    if (req.method() !== "POST" || !req.url().includes("/run-loop")) {
      return;
    }

    try {
      const body = req.postData() ?? "";
      if (body.includes("evaluate_prd")) {
        captured.push(`${req.method()} ${req.url()} body=${body}`);
      }
    } catch {
      // postData() can throw for non-text bodies — ignore.
    }
  });

  return captured;
}

test("Generate Plan on a Feature does NOT trigger an evaluate_prd run-loop request", async ({
  page,
  request,
}) => {
  const team = await createTeam(request, {
    name: createUniqueName("e2e-plan-eval"),
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-plan-eval"),
    teamIds: [team.id],
  });

  const featureTitle = createUniqueName("e2e-feature");
  const feature = await createDocument(request, {
    projectId: project.id,
    type: "FEATURE",
    title: featureTitle,
    content: "Feature description for E2E plan-evaluation test.",
  });

  test.info().annotations.push({
    type: "cleanup",
    description: `feature=${feature.id}, project=${project.id}, team=${team.id}`,
  });

  // Set up network monitoring BEFORE navigating to capture any evaluate_prd
  // requests dispatched as a side effect.
  const evaluatePrdRequests = captureEvaluatePrdRequests(page);

  await authenticateToApp(page);
  await page.goto(`/features/${feature.slug}`);

  const generatePlanButton = page.getByRole("button", {
    name: RE_GENERATE_PLAN_BUTTON,
  });
  await expect(generatePlanButton).toBeVisible({ timeout: 30_000 });
  await expect(generatePlanButton).toBeEnabled({ timeout: 10_000 });

  await generatePlanButton.click();

  const modal = page.getByRole("dialog", {
    name: RE_GENERATE_PLAN_MODAL_TITLE,
  });
  await expect(modal).toBeVisible({ timeout: 10_000 });

  // The modal pre-populates the title from the feature, but fill it if empty.
  const titleInput = modal.getByLabel(RE_PLAN_TITLE_INPUT);
  await expect(titleInput).toBeVisible();
  const existingTitle = await titleInput.inputValue();
  if (!existingTitle.trim()) {
    await titleInput.fill(`Plan: ${featureTitle}`);
  }

  // Intercept the POST to /documents (plan creation) to capture the created
  // document ID so we can clean it up.
  const planCreateResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/documents") &&
      !response.url().includes("/run-loop"),
    { timeout: 15_000 }
  );

  const submitButton = modal.getByRole("button", {
    name: RE_GENERATE_PLAN_BUTTON,
  });
  await expect(submitButton).toBeVisible();
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  const planResponse = await planCreateResponse.catch(() => null);

  // Clean up the created plan document.
  if (planResponse?.ok()) {
    try {
      const body = (await planResponse.json()) as ApiResult<DocumentSummary>;
      if (body.success && body.data.id) {
        await deleteDocument(request, body.data.id);
      }
    } catch {
      // Ignore cleanup errors.
    }
  }

  // Allow time for any async run-loop side effects to fire before asserting.
  await page.waitForTimeout(2000).catch(() => null);

  expect(evaluatePrdRequests).toHaveLength(0);

  await deleteDocument(request, feature.id);
});

test("Evaluate PRD on a PRD document DOES trigger an evaluate_prd run-loop request", async ({
  page,
  request,
}) => {
  const team = await createTeam(request, {
    name: createUniqueName("e2e-plan-eval"),
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-plan-eval"),
    teamIds: [team.id],
  });

  const prd = await createDocument(request, {
    projectId: project.id,
    type: "PRD",
    title: createUniqueName("e2e-prd"),
    content: "PRD content for E2E plan-evaluation test.",
  });

  test.info().annotations.push({
    type: "cleanup",
    description: `prd=${prd.id}, project=${project.id}, team=${team.id}`,
  });

  // Set up network monitoring BEFORE navigating.
  const evaluatePrdRequests = captureEvaluatePrdRequests(page);

  await authenticateToApp(page);
  await page.goto(`/prds/${prd.slug}`);

  const actionsButton = page.getByRole("button", { name: RE_ACTIONS_BUTTON });
  await expect(actionsButton).toBeVisible({ timeout: 30_000 });
  await expect(actionsButton).toBeEnabled({ timeout: 10_000 });

  await actionsButton.click();

  const evaluatePrdMenuItem = page.getByRole("menuitem", {
    name: RE_EVALUATE_PRD_BUTTON,
  });
  await expect(evaluatePrdMenuItem).toBeVisible({ timeout: 10_000 });

  const runLoopResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/run-loop"),
    { timeout: 15_000 }
  );

  await evaluatePrdMenuItem.click();

  await runLoopResponse.catch(() => null);

  expect(evaluatePrdRequests).toHaveLength(1);

  await deleteDocument(request, prd.id);
});
