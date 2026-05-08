import { expect, type Locator, type Page } from "@playwright/test";

const RE_ADD_TEAM = /add team/i;
const RE_ADD_PROJECT = /add project/i;
const RE_CREATE_TEAM_DIALOG = /create team/i;
const RE_CREATE_PROJECT_DIALOG = /create project/i;
const RE_CREATE_NEW_FEATURE_DIALOG = /create new feature/i;
const RE_CREATE_FEATURE_MENU = /create feature/i;
const RE_CREATE_TEAM_SUBMIT = /^create team$/i;
const RE_CREATE_PROJECT_SUBMIT = /^create project$/i;
const RE_CREATE_FEATURE_SUBMIT = /^create feature$/i;

export async function openDialog(
  page: Page,
  triggerName: RegExp,
  dialogName: RegExp
): Promise<Locator> {
  await page.getByRole("button", { name: triggerName }).click();
  const dialog = page.getByRole("dialog", { name: dialogName });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function fillControlledField(
  dialog: Locator,
  fieldSelector: string,
  value: string
): Promise<void> {
  const input = dialog.locator(fieldSelector);
  await expect(input).toBeVisible();
  await input.click();
  await input.fill(value);
  await expect(input).toHaveValue(value);
}

async function clickSubmitAndWaitForClose(
  page: Page,
  dialog: Locator,
  submitButton: Locator,
  responsePath?: string
): Promise<void> {
  const responsePromise = responsePath
    ? page
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().includes(responsePath),
          { timeout: 10_000 }
        )
        .then(async (response) => ({
          body: await response.text().catch(() => null),
          ok: response.ok(),
          status: response.status(),
          url: response.url(),
        }))
        .catch(() => null)
    : Promise.resolve(null);

  try {
    await expect(submitButton).toBeVisible();
    await expect(submitButton).toBeEnabled();
    await submitButton.scrollIntoViewIfNeeded();
    await installDialogSubmitDiagnostics(dialog, submitButton);
    await submitButton.click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
  } catch (error) {
    const [diagnostics, responseSummary] = await Promise.all([
      collectDialogDiagnostics(dialog, submitButton),
      responsePromise,
    ]);
    const diagnosticMessage = formatDialogSubmitFailureDiagnostics({
      diagnostics,
      responseSummary,
    });
    console.error(`[e2e] ${diagnosticMessage}`);
    throw new Error(diagnosticMessage, { cause: error });
  }
}

async function installDialogSubmitDiagnostics(
  dialog: Locator,
  submitButton: Locator
): Promise<void> {
  const form = dialog.locator("form");

  await form.evaluate((formElement: HTMLFormElement) => {
    const debugTarget = window as Window & {
      __e2eDialogSubmitDebug?: {
        submitCount: number;
        lastSubmitterText: string | null;
      };
    };

    debugTarget.__e2eDialogSubmitDebug = {
      submitCount: 0,
      lastSubmitterText: null,
    };

    formElement.addEventListener(
      "submit",
      (event) => {
        const submitEvent = event as SubmitEvent;
        const submitter = submitEvent.submitter;

        if (!debugTarget.__e2eDialogSubmitDebug) {
          return;
        }

        debugTarget.__e2eDialogSubmitDebug.submitCount += 1;
        debugTarget.__e2eDialogSubmitDebug.lastSubmitterText =
          submitter?.textContent?.trim() ?? null;
      },
      { capture: true, once: false }
    );
  });

  await submitButton.evaluate((button: HTMLButtonElement) => {
    const debugTarget = window as Window & {
      __e2eDialogButtonDebug?: {
        clickCount: number;
      };
    };

    debugTarget.__e2eDialogButtonDebug = {
      clickCount: 0,
    };

    button.addEventListener(
      "click",
      () => {
        if (!debugTarget.__e2eDialogButtonDebug) {
          return;
        }

        debugTarget.__e2eDialogButtonDebug.clickCount += 1;
      },
      { capture: true, once: false }
    );
  });
}

async function collectDialogDiagnostics(
  dialog: Locator,
  submitButton: Locator
): Promise<Record<string, unknown>> {
  const [buttonState, dialogText, fieldValues, submitDebug, buttonDebug] =
    await Promise.all([
      submitButton
        .evaluate((button: HTMLButtonElement) => ({
          ariaDisabled: button.getAttribute("aria-disabled"),
          disabled: button.disabled,
          text: button.textContent?.trim() ?? "",
          type: button.getAttribute("type"),
        }))
        .catch(() => null),
      dialog.textContent().catch(() => null),
      dialog
        .locator("input, textarea")
        .evaluateAll((elements) =>
          elements.map((element) => {
            if (
              element instanceof HTMLInputElement ||
              element instanceof HTMLTextAreaElement
            ) {
              return {
                id: element.id,
                name: element.getAttribute("name"),
                value: element.value,
              };
            }
            return null;
          })
        )
        .catch(() => null),
      dialog
        .evaluate(
          () =>
            (
              window as Window & {
                __e2eDialogSubmitDebug?: unknown;
              }
            ).__e2eDialogSubmitDebug ?? null
        )
        .catch(() => null),
      dialog
        .evaluate(
          () =>
            (
              window as Window & {
                __e2eDialogButtonDebug?: unknown;
              }
            ).__e2eDialogButtonDebug ?? null
        )
        .catch(() => null),
    ]);

  return {
    buttonDebug,
    buttonState,
    dialogText,
    fieldValues,
    submitDebug,
  };
}

function formatDialogSubmitFailureDiagnostics(input: {
  diagnostics: Record<string, unknown>;
  responseSummary: unknown;
}) {
  const { diagnostics, responseSummary } = input;

  const safeStringify = (value: unknown) => {
    try {
      const serialized = JSON.stringify(value, null, 2);
      return serialized ?? String(value);
    } catch (error) {
      return `[unserializable: ${error instanceof Error ? error.message : String(error)}]`;
    }
  };

  return [
    "Dialog submit failed with diagnostics:",
    `buttonState=${safeStringify(diagnostics.buttonState ?? null)}`,
    `buttonDebug=${safeStringify(diagnostics.buttonDebug ?? null)}`,
    `submitDebug=${safeStringify(diagnostics.submitDebug ?? null)}`,
    `fieldValues=${safeStringify(diagnostics.fieldValues ?? null)}`,
    `responseSummary=${safeStringify(responseSummary ?? null)}`,
    `dialogText=${safeStringify(diagnostics.dialogText ?? null)}`,
  ].join("\n");
}

async function submitDialogForm(
  page: Page,
  dialog: Locator,
  {
    fieldSelector,
    responsePath,
    submitButtonName,
    value,
  }: {
    fieldSelector: string;
    responsePath?: string;
    submitButtonName: RegExp;
    value: string;
  }
): Promise<void> {
  await fillControlledField(dialog, fieldSelector, value);

  const submitButton = dialog.getByRole("button", {
    name: submitButtonName,
  });
  await clickSubmitAndWaitForClose(page, dialog, submitButton, responsePath);
}

export async function createTeamViaSidebar(
  page: Page,
  teamName: string
): Promise<Locator> {
  const dialog = await openDialog(page, RE_ADD_TEAM, RE_CREATE_TEAM_DIALOG);
  await submitDialogForm(page, dialog, {
    fieldSelector: "#team-name",
    responsePath: "/teams",
    submitButtonName: RE_CREATE_TEAM_SUBMIT,
    value: teamName,
  });
  return dialog;
}

export async function createProjectViaDialog(
  page: Page,
  projectName: string
): Promise<Locator> {
  const dialog = await openDialog(
    page,
    RE_ADD_PROJECT,
    RE_CREATE_PROJECT_DIALOG
  );
  await submitDialogForm(page, dialog, {
    fieldSelector: "#name",
    responsePath: "/projects",
    submitButtonName: RE_CREATE_PROJECT_SUBMIT,
    value: projectName,
  });
  return dialog;
}

export async function createFeatureViaActions(
  page: Page,
  featureTitle: string
): Promise<Locator> {
  const actionsButton = page.getByRole("button", { name: "Actions" }).first();
  await expect(actionsButton).toBeVisible({ timeout: 15_000 });
  await actionsButton.click();

  await page.getByRole("menuitem", { name: RE_CREATE_FEATURE_MENU }).click();

  const dialog = page.getByRole("dialog", {
    name: RE_CREATE_NEW_FEATURE_DIALOG,
  });
  await expect(dialog).toBeVisible();

  await fillControlledField(dialog, "#feature-title", featureTitle);
  const submitButton = dialog.getByRole("button", {
    name: RE_CREATE_FEATURE_SUBMIT,
  });
  await clickSubmitAndWaitForClose(page, dialog, submitButton, "/documents");

  return dialog;
}
