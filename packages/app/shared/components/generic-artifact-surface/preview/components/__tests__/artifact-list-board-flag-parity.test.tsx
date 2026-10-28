// @vitest-environment jsdom

import { MANUAL_ARTIFACT_ORDERING_FLAG_KEY } from "@repo/api/src/types/manual-artifact-ordering-flag";
import { fireEvent, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOARD_VIEW,
  FIRST_ARTIFACT_TITLE,
  nthElement,
  renderShell,
  SHELL_FLOW_TIMEOUT_MS,
} from "./support/list-shell-harness";

const enabledFlags = vi.hoisted(() => new Set<string>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", async () => {
  const actual = await vi.importActual<
    typeof import("@repo/app/shared/feature-flags/use-feature-flag-enabled")
  >("@repo/app/shared/feature-flags/use-feature-flag-enabled");
  return {
    ...actual,
    useFeatureFlagEnabledOptional: (flag: string) => enabledFlags.has(flag),
  };
});

const ARTIFACT_BOARD_SELECTOR = "[data-artifact-board]";

function openBoard() {
  fireEvent.click(
    nthElement(screen.getAllByRole("radio", { name: BOARD_VIEW }), 0)
  );
}

beforeEach(() => {
  enabledFlags.clear();
});

describe("Issues and Documents board behind manual-artifact-ordering", () => {
  it(
    "keeps main's status board with the key off",
    () => {
      renderShell();
      openBoard();

      expect(screen.getByText(FIRST_ARTIFACT_TITLE)).toBeTruthy();
      expect(document.querySelector(ARTIFACT_BOARD_SELECTOR)).toBeNull();
    },
    SHELL_FLOW_TIMEOUT_MS
  );

  it(
    "renders the shared Artifact Board with the key on",
    () => {
      enabledFlags.add(MANUAL_ARTIFACT_ORDERING_FLAG_KEY);
      renderShell();
      openBoard();

      expect(screen.getByText(FIRST_ARTIFACT_TITLE)).toBeTruthy();
      expect(document.querySelector(ARTIFACT_BOARD_SELECTOR)).not.toBeNull();
    },
    SHELL_FLOW_TIMEOUT_MS
  );
});
