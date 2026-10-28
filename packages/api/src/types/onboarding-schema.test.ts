import { describe, expect, it } from "vitest";
import {
  ChecklistItemId,
  type OnboardingChecklistItem,
  type OnboardingStatus,
} from "./onboarding.ts";
import { onboardingStatusSchema } from "./onboarding-schema.ts";

/** An id this bundle does not know: a checklist row a newer server added. */
const UNKNOWN_CHECKLIST_ITEM_ID = "FUTURE_CHECKLIST_ITEM";

describe("onboardingStatusSchema", () => {
  it("drops a checklist row whose id this bundle does not know, and keeps the status", () => {
    const status = validStatus();
    const parsed = onboardingStatusSchema.safeParse({
      ...status,
      checklist: [
        ...status.checklist,
        { ...checklistItem(), id: UNKNOWN_CHECKLIST_ITEM_ID },
      ],
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.checklist).toEqual(status.checklist);
  });

  it("still rejects a row with a known id and a malformed field", () => {
    const parsed = onboardingStatusSchema.safeParse({
      ...validStatus(),
      checklist: [{ ...checklistItem(), completed: "yes" }],
    });

    expect(parsed.success).toBe(false);
  });
});

function checklistItem(
  overrides: Partial<OnboardingChecklistItem> = {}
): OnboardingChecklistItem {
  return {
    completed: false,
    description: "Group your work under a team.",
    id: ChecklistItemId.CreateTeam,
    label: "Create a team",
    ...overrides,
  };
}

function validStatus(): OnboardingStatus {
  return {
    checklist: [
      checklistItem(),
      checklistItem({
        completed: true,
        external: true,
        href: "https://closedloop.ai/download",
        id: ChecklistItemId.DownloadDesktop,
        label: "Download Closedloop Desktop",
      }),
    ],
    checklistDismissed: false,
    wizardCompleted: true,
  };
}
