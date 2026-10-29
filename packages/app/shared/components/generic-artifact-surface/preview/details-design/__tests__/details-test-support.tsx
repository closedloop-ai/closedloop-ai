import { DetailsPriorityEditorHost } from "@repo/app/documents/components/details-design/details-design-preview-host";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { type RenderResult, render } from "@testing-library/react";
import {
  DetailsAvailability,
  type DetailsConfig,
  type DetailsField,
  DetailsFieldId,
  type DetailsFieldValue,
  DetailsReadOnlyKind,
  DetailsRowFlag,
  forViewer,
} from "../details-design-model";
import { DetailsSections } from "../details-sections";

/** Shared helpers for the ISS-10792 Details harness suites. */
export const ALL_ROW_FLAGS = [
  DetailsRowFlag.LaunchAttribution,
  DetailsRowFlag.SessionsTags,
];

export function renderDetails(
  config: DetailsConfig,
  availability: DetailsAvailability = DetailsAvailability.CanEdit,
  enabledFlags: readonly string[] = ALL_ROW_FLAGS
): RenderResult {
  return render(
    <FeatureFlagAdapterProvider
      adapter={createStaticFeatureFlagAdapter({
        enabledFlags: [...enabledFlags],
      })}
    >
      <TooltipProvider>
        <DetailsSections
          config={forViewer(config, availability)}
          priorityEditor={DetailsPriorityEditorHost}
        />
      </TooltipProvider>
    </FeatureFlagAdapterProvider>
  );
}

/** Non-circular: the tests' own wording, not the fixtures'. */
export const VIEWER_REASONS: DetailsConfig["viewerReasons"] = {
  "desktop-offline": "Test: offline.",
  "no-permission": "Test: no permission.",
};
export const SAVE_ERROR = "Test: refused.";
export const readOnlyName = (label: string, reason: string) =>
  `Test: ${label} locked. ${reason}`;

export function configOf(
  core: readonly DetailsField<DetailsFieldId>[],
  customFields: readonly DetailsField[] = []
): DetailsConfig {
  return {
    core,
    customFields,
    linkRows: [],
    linked: [],
    readOnlyName,
    saveErrorLabel: SAVE_ERROR,
    viewerReasons: VIEWER_REASONS,
  };
}

/** One custom-field row with a spy save, so editor behaviour is isolated. */
export function oneTextField(
  onSave: (next: DetailsFieldValue) => Promise<void>
) {
  return configOf(
    [],
    [
      {
        edit: { mode: "editable", onSave },
        id: "cf-risk",
        label: "Risk",
        value: { kind: "text", text: "" },
      },
    ]
  );
}

export function collaborators(
  value: Extract<DetailsFieldValue, { kind: "people" }>
) {
  return configOf([
    {
      edit: {
        mode: "read-only",
        reason: { kind: DetailsReadOnlyKind.NotEditable, text: "Derived." },
      },
      id: DetailsFieldId.Collaborators,
      label: "Collaborators",
      value,
    },
  ]);
}

/** A tags row whose writes the test settles by hand. */
export function tagsField(onSave: (next: DetailsFieldValue) => Promise<void>) {
  return configOf([
    {
      edit: { mode: "editable", onSave },
      id: DetailsFieldId.Tags,
      label: "Tags",
      value: { kind: "tags", tags: ["Product"] },
    },
  ]);
}

export function cellOf(id: DetailsFieldId) {
  return document.querySelector(`[data-details-field="${id}"]`) as HTMLElement;
}

export function deferred() {
  let reject: (error: Error) => void = () => undefined;
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, reject, resolve };
}

export const EDIT_BUTTON = /^Edit /;
export const PRIORITY_TRIGGER = /^Priority: /;
export const READ_ONLY_NAME = /^Fixture: Collaborators is read-only\. /;
export const DURATION_EVIDENCE = "Fixture: first to last event";
/** Production's source word for the reported figure (`SessionCostValue`). */
export const CLAUDE_REPORTED = "Claude reported";
export const RESEARCH_OPTION = /Research/;
export const DESIGN_OPTION = /Design system/;
export const STATUS_TRIGGER = /^Status/;
export const ISSUE_LINK = /ISS-0001/;
export const PR_LINK = /#101/;
export const BRANCH_ISSUE_LINK = /ISS-0004/;
export const BRANCH_PR_LINK = /#201/;
