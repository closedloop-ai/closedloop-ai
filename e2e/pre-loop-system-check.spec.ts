import type { APIRequestContext, Page } from "@playwright/test";
import { type ApiResult, Priority } from "@repo/api/src/types/common";
import { ComputePreference } from "@repo/api/src/types/compute-target";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document";
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
import {
  createDocument,
  type DocumentSummary,
  deleteDocument,
} from "./helpers/documents";
import { authenticateToApp } from "./helpers/sign-in";
import { createUniqueName } from "./helpers/utils";
import { expect, test } from "./test";

const COMPUTE_TARGET_HEADER = "x-compute-target";
const GATEWAY_HEALTH_CHECK_PATH = "/api/gateway/health-check";
const GATEWAY_RELAY_HEALTH_CHECK_PATH = "/api/gateway-relay/health-check";
const RE_GENERATE_PLAN_BUTTON = /generate plan/i;
const RE_GENERATE_PLAN_MODAL_TITLE = /generate implementation plan/i;
const RE_PLAN_TITLE_INPUT = /title/i;
const RE_SYSTEM_CHECK_DIALOG_TITLE = /system check/i;
const RE_CONTINUE_BUTTON = /^continue$/i;
const RE_RECHECK_BUTTON = /^re-check$/i;
const RE_GATEWAY_VERSION = /gateway version/i;
const DOCUMENT_CREATE_PATH_RE = /^\/documents$/;
const RUN_LOOP_PATH_RE = /^\/documents\/[^/]+\/run-loop$/;

type HealthCheckResponse = {
  checks: Array<{
    id: string;
    label: string;
    required: boolean;
    passed: boolean;
    error?: string;
    remediation?: string;
    version?: string;
  }>;
  allRequiredPassed: boolean;
};

type Fixture = {
  feature: DocumentSummary;
  projectId: string;
  teamId: string;
};

function makePassingHealthCheck(): HealthCheckResponse {
  return {
    checks: [
      {
        id: "app-version",
        label: "Gateway Version",
        required: true,
        passed: true,
        version: "0.14.11",
      },
      {
        id: "git",
        label: "Git",
        required: true,
        passed: true,
        version: "2.54.0",
      },
    ],
    allRequiredPassed: true,
  };
}

function makeFailingHealthCheck(): HealthCheckResponse {
  return {
    checks: [
      {
        id: "app-version",
        label: "Gateway Version",
        required: true,
        passed: false,
        version: "0.14.10",
        error: "Update available: 0.14.11",
        remediation: "Open the ClosedLoop Gateway app to update",
      },
    ],
    allRequiredPassed: false,
  };
}

function isApiDocumentsPost(url: string, method: string): boolean {
  return (
    method === "POST" && DOCUMENT_CREATE_PATH_RE.test(new URL(url).pathname)
  );
}

function isRunLoopPost(url: string, method: string): boolean {
  return method === "POST" && RUN_LOOP_PATH_RE.test(new URL(url).pathname);
}

async function createFeatureFixture(
  request: APIRequestContext,
  token: string
): Promise<Fixture> {
  const team = await createTeam(request, {
    name: createUniqueName("e2e-pre-loop"),
    token,
  });
  const project = await createProject(request, {
    name: createUniqueName("e2e-pre-loop"),
    teamIds: [team.id],
    defaultRepository: {
      repoId: "e2e-stub",
      repoFullName: "e2e/stub",
      branch: "main",
    },
    token,
  });
  const feature = await createDocument(request, {
    projectId: project.id,
    type: DocumentType.Feature,
    title: createUniqueName("e2e-pre-loop-feature"),
    content: "Feature content for pre-loop system check E2E coverage.",
    token,
  });

  return { feature, projectId: project.id, teamId: team.id };
}

async function cleanupFixture(
  request: APIRequestContext,
  fixture: Fixture | null,
  token: string
): Promise<void> {
  if (!fixture) {
    return;
  }
  await deleteDocument(request, fixture.feature.id, token);
  await deleteProject(request, fixture.projectId, token);
  await deleteTeam(request, fixture.teamId, token);
}

async function installReleaseRoute(page: Page) {
  await page.route("**/electron-release", async (route) => {
    await route.fulfill({
      body: JSON.stringify({
        success: true,
        data: {
          downloadUrl: "https://example.invalid/ClosedLoop.dmg",
          releaseNotes: "",
          version: "0.14.11",
        },
      }),
      contentType: "application/json",
      status: 200,
    });
  });
}

async function installAmbientGatewayRoute(page: Page) {
  await page.route(`**${GATEWAY_HEALTH_CHECK_PATH}**`, async (route) => {
    await route.fulfill({
      body: JSON.stringify(makePassingHealthCheck()),
      contentType: "application/json",
      status: 200,
    });
  });
}

async function openGeneratePlanModal(page: Page) {
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
  await modal
    .getByLabel(RE_PLAN_TITLE_INPUT)
    .fill(createUniqueName("E2E Plan"));
  return modal;
}

test.describe.configure({ mode: "serial" });

test("Generate Plan blocks document creation when the required pre-loop system check fails", async ({
  page,
  request,
}) => {
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);
  const previousPreference = await getComputePreference(request, token);
  const computeTarget = await registerComputeTarget(request, {
    machineName: createUniqueName("e2e-pre-loop-target"),
    token,
  });
  let fixture: Fixture | null = null;
  let documentPostCount = 0;
  let runLoopPostCount = 0;
  const relayHealthCheckHeaders: string[] = [];

  try {
    await setComputePreference(request, {
      mode: ComputePreference.Local,
      computeTargetId: computeTarget.id,
      token,
    });
    fixture = await createFeatureFixture(request, token);
    await installReleaseRoute(page);
    await installAmbientGatewayRoute(page);
    await page.route(
      `**${GATEWAY_RELAY_HEALTH_CHECK_PATH}**`,
      async (route) => {
        relayHealthCheckHeaders.push(
          route.request().headers()[COMPUTE_TARGET_HEADER] ?? ""
        );
        await route.fulfill({
          body: JSON.stringify(makeFailingHealthCheck()),
          contentType: "application/json",
          status: 200,
        });
      }
    );
    await page.route("**/documents", async (route) => {
      if (
        !isApiDocumentsPost(route.request().url(), route.request().method())
      ) {
        await route.continue();
        return;
      }

      documentPostCount += 1;
      await route.fulfill({
        body: JSON.stringify({
          success: true,
          data: {
            id: "blocked-plan-should-not-create",
            organizationId: "e2e",
            workstreamId: null,
            projectId: fixture?.projectId ?? null,
            type: DocumentType.ImplementationPlan,
            title: "Blocked plan",
            slug: "blocked-plan-should-not-create",
            fileName: null,
            status: DocumentStatus.Draft,
            priority: Priority.Medium,
            latestVersion: 1,
            createdById: "e2e",
            assigneeId: null,
            assignee: null,
            approverId: null,
          },
        }),
        contentType: "application/json",
        status: 200,
      });
    });
    await page.route("**/documents/**/run-loop", async (route) => {
      if (!isRunLoopPost(route.request().url(), route.request().method())) {
        await route.continue();
        return;
      }
      runLoopPostCount += 1;
      await route.fulfill({
        body: JSON.stringify({
          success: true,
          data: { loopId: "blocked-loop-should-not-run", status: "pending" },
        }),
        contentType: "application/json",
        status: 200,
      });
    });

    await page.goto(`/features/${fixture.feature.slug}`);
    const modal = await openGeneratePlanModal(page);
    await modal
      .getByRole("button", { name: RE_GENERATE_PLAN_BUTTON })
      .click({ force: true });

    const systemCheckDialog = page.getByRole("dialog", {
      name: RE_SYSTEM_CHECK_DIALOG_TITLE,
    });
    await expect(systemCheckDialog).toBeVisible({ timeout: 15_000 });
    await expect(
      systemCheckDialog.getByRole("button", { name: RE_CONTINUE_BUTTON })
    ).toBeDisabled();
    await expect(systemCheckDialog.getByText(RE_GATEWAY_VERSION)).toBeVisible({
      timeout: 15_000,
    });
    expect(relayHealthCheckHeaders).toEqual([computeTarget.id]);
    await expect(
      systemCheckDialog.getByRole("button", { name: RE_CONTINUE_BUTTON })
    ).toBeDisabled();

    expect(documentPostCount).toBe(0);
    expect(runLoopPostCount).toBe(0);
  } finally {
    await restoreComputePreference(request, previousPreference, token);
    await deleteComputeTarget(request, computeTarget.id, token);
    await cleanupFixture(request, fixture, token);
  }
});

test("Generate Plan resumes only after Re-check returns a passing system check", async ({
  page,
  request,
}) => {
  await authenticateToApp(page, { fresh: true });
  const token = await getClerkBearerToken(page);
  const previousPreference = await getComputePreference(request, token);
  const computeTarget = await registerComputeTarget(request, {
    machineName: createUniqueName("e2e-pre-loop-target"),
    token,
  });
  let fixture: Fixture | null = null;
  let createdPlanId: string | null = null;
  let healthShouldPass = false;
  let runLoopPostCount = 0;
  const relayHealthCheckHeaders: string[] = [];

  try {
    await setComputePreference(request, {
      mode: ComputePreference.Local,
      computeTargetId: computeTarget.id,
      token,
    });
    fixture = await createFeatureFixture(request, token);
    await installReleaseRoute(page);
    await installAmbientGatewayRoute(page);
    await page.route(
      `**${GATEWAY_RELAY_HEALTH_CHECK_PATH}**`,
      async (route) => {
        relayHealthCheckHeaders.push(
          route.request().headers()[COMPUTE_TARGET_HEADER] ?? ""
        );
        await route.fulfill({
          body: JSON.stringify(
            healthShouldPass
              ? makePassingHealthCheck()
              : makeFailingHealthCheck()
          ),
          contentType: "application/json",
          status: 200,
        });
      }
    );
    await page.route("**/documents/**/run-loop", async (route) => {
      if (!isRunLoopPost(route.request().url(), route.request().method())) {
        await route.continue();
        return;
      }
      runLoopPostCount += 1;
      await route.fulfill({
        body: JSON.stringify({
          success: true,
          data: { loopId: "e2e-pre-loop-run-loop", status: "pending" },
        }),
        contentType: "application/json",
        status: 200,
      });
    });

    await page.goto(`/features/${fixture.feature.slug}`);
    const modal = await openGeneratePlanModal(page);
    await modal
      .getByRole("button", { name: RE_GENERATE_PLAN_BUTTON })
      .click({ force: true });

    const systemCheckDialog = page.getByRole("dialog", {
      name: RE_SYSTEM_CHECK_DIALOG_TITLE,
    });
    await expect(systemCheckDialog).toBeVisible({ timeout: 15_000 });
    await expect(
      systemCheckDialog.getByRole("button", { name: RE_CONTINUE_BUTTON })
    ).toBeDisabled();
    await expect(systemCheckDialog.getByText(RE_GATEWAY_VERSION)).toBeVisible({
      timeout: 15_000,
    });
    expect(relayHealthCheckHeaders).toEqual([computeTarget.id]);

    const planCreateResponse = page.waitForResponse(
      (response) =>
        isApiDocumentsPost(response.url(), response.request().method()) &&
        response.ok(),
      { timeout: 20_000 }
    );
    const runLoopResponse = page.waitForResponse(
      (response) =>
        isRunLoopPost(response.url(), response.request().method()) &&
        response.ok(),
      { timeout: 20_000 }
    );
    healthShouldPass = true;
    await systemCheckDialog
      .getByRole("button", { name: RE_RECHECK_BUTTON })
      .click();

    const response = await planCreateResponse;
    await runLoopResponse;
    const body = (await response.json()) as ApiResult<DocumentSummary>;
    if (body.success) {
      createdPlanId = body.data.id;
    }

    await expect(systemCheckDialog).not.toBeVisible({ timeout: 15_000 });
    expect(relayHealthCheckHeaders).toEqual([
      computeTarget.id,
      computeTarget.id,
    ]);
    expect(runLoopPostCount).toBe(1);
  } finally {
    if (createdPlanId) {
      await deleteDocument(request, createdPlanId, token);
    }
    await restoreComputePreference(request, previousPreference, token);
    await deleteComputeTarget(request, computeTarget.id, token);
    await cleanupFixture(request, fixture, token);
  }
});
