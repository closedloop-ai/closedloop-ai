/**
 * E2E tests for PLN-442: plan generation and PRD evaluation run-loop routing.
 *
 * Test 1 (regression guard): When a user clicks "Generate Plan" on a Feature
 * that is sourced from a PRD (PRODUCES link), submitting the NewPlanModal must
 * NOT cause the server to dispatch an EVALUATE_PRD loop on the source PRD as a
 * side effect. The check queries the loops API for EVALUATE_PRD loops on the
 * source PRD and asserts none were created — this catches the actual server
 * side effect (which the client never observes).
 *
 * Test 2 (positive case): When a user clicks "Evaluate PRD" on a PRD document,
 * the run-loop endpoint must be called with command="evaluate_prd".
 */
import { LinkType } from "@repo/api/src/types/artifact";
import type { ApiResult } from "@repo/api/src/types/common";
import { DocumentType } from "@repo/api/src/types/document";
import { LoopCommand, RunLoopCommand } from "@repo/api/src/types/loop";
import { createArtifactLink } from "./helpers/artifact-links";
import { getClerkBearerToken } from "./helpers/clerk-token";
import { createProject, deleteProject } from "./helpers/create-project";
import { createTeam, deleteTeam } from "./helpers/create-team";
import {
  createDocument,
  type DocumentSummary,
  deleteDocument,
} from "./helpers/documents";
import { countLoops } from "./helpers/loops";
import { authenticateToApp } from "./helpers/sign-in";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const RE_GENERATE_PLAN_MODAL_TITLE = /generate implementation plan/i;
const RE_GENERATE_PLAN_BUTTON = /generate plan/i;
const RE_PLAN_TITLE_INPUT = /title/i;
const RE_ACTIONS_BUTTON = /^actions$/i;
const RE_EVALUATE_PRD_BUTTON = /evaluate prd/i;

test("Generate Plan on a Feature sourced from a PRD does NOT create an EVALUATE_PRD loop on the source PRD", async ({
  page,
  request,
}) => {
  // Sign in before any API calls — the request fixture has no Clerk session
  // for the cross-origin api-* subdomain, so helpers must attach a Bearer JWT
  // pulled from the authenticated page.
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);

  const team = await createTeam(request, {
    name: createUniqueName("e2e-plan-eval"),
    token,
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-plan-eval"),
    teamIds: [team.id],
    // The Generate Plan submit button gates on project.settings.defaultRepository
    // when a source document is selected (NewPlanModal isCreateSubmitDisabled).
    // Stub a repository so the form is submittable in the test environment.
    defaultRepository: {
      repoId: "e2e-stub",
      repoFullName: "e2e/stub",
      branch: "main",
    },
    token,
  });

  const prd = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Prd,
    title: createUniqueName("e2e-source-prd"),
    content: "Source PRD content for E2E plan-evaluation regression test.",
    token,
  });

  const featureTitle = createUniqueName("e2e-feature");
  const feature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: featureTitle,
    content: "Feature description for E2E plan-evaluation test.",
    token,
  });

  // Establish the PRD → Feature source link so the regression condition
  // (source?.type === ArtifactType.Document) would be satisfied if present.
  await createArtifactLink(request, {
    sourceId: prd.id,
    targetId: feature.id,
    linkType: LinkType.Produces,
    token,
  });

  test.info().annotations.push({
    type: "cleanup",
    description: `prd=${prd.id}, feature=${feature.id}, project=${project.id}, team=${team.id}`,
  });

  let createdPlanId: string | null = null;

  try {
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

    const titleInput = modal.getByLabel(RE_PLAN_TITLE_INPUT);
    await expect(titleInput).toBeVisible();
    const existingTitle = await titleInput.inputValue();
    if (!existingTitle.trim()) {
      await titleInput.fill(`Plan: ${featureTitle}`);
    }

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
    // The Radix DialogContent is position:fixed without max-height or
    // overflow-y, so when the modal is taller than the viewport the footer
    // renders below the fold and Playwright's auto-scroll cannot bring it in.
    // Visibility and enabled-state are already asserted above, so force the
    // click to bypass the viewport check.
    await submitButton.click({ force: true });

    const planResponse = await planCreateResponse.catch(() => null);

    expect(
      planResponse,
      "Plan creation POST was never observed — test did not exercise the regression path"
    ).not.toBeNull();
    expect(planResponse?.ok(), "Plan creation POST returned non-2xx").toBe(
      true
    );

    if (planResponse?.ok()) {
      try {
        const body = (await planResponse.json()) as ApiResult<DocumentSummary>;
        if (body.success && body.data.id) {
          createdPlanId = body.data.id;
        }
      } catch {
        // Ignore parse errors — cleanup will still drop project/team.
      }
    }

    // Server-side check: poll the loops API for any EVALUATE_PRD loop on the
    // source PRD. If the regression returns, scheduleAutoEvaluatePrd would
    // create one here.
    const evaluatePrdLoopCount = await countLoops(request, {
      documentId: prd.id,
      command: LoopCommand.EvaluatePrd,
      token,
    });
    expect(evaluatePrdLoopCount).toBe(0);
  } finally {
    if (createdPlanId) {
      await deleteDocument(request, createdPlanId, token);
    }
    await deleteDocument(request, feature.id, token);
    await deleteDocument(request, prd.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
  }
});

test("Evaluate PRD on a PRD document DOES trigger an evaluate_prd run-loop request", async ({
  page,
  request,
}) => {
  // Sign in before any API calls — see comment in the previous test.
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);

  const team = await createTeam(request, {
    name: createUniqueName("e2e-plan-eval"),
    token,
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-plan-eval"),
    teamIds: [team.id],
    token,
  });

  const prd = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Prd,
    title: createUniqueName("e2e-prd"),
    content: "PRD content for E2E plan-evaluation test.",
    token,
  });

  test.info().annotations.push({
    type: "cleanup",
    description: `prd=${prd.id}, project=${project.id}, team=${team.id}`,
  });

  try {
    const evaluatePrdRequests: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "POST" || !req.url().includes("/run-loop")) {
        return;
      }
      try {
        const body = req.postData() ?? "";
        if (body.includes(RunLoopCommand.EvaluatePrd)) {
          evaluatePrdRequests.push(`${req.method()} ${req.url()} body=${body}`);
        }
      } catch {
        // postData() can throw for non-text bodies — ignore.
      }
    });

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
  } finally {
    await deleteDocument(request, prd.id, token);
    await deleteProject(request, project.id, token);
    await deleteTeam(request, team.id, token);
  }
});
