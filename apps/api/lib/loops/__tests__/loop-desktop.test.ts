/**
 * Unit tests for buildDesktopLoopExecutionBody() in loop-desktop.ts.
 *
 * Covers:
 * - When harness is provided in LaunchDesktopOpts, it appears in the LoopBody output
 * - When harness is undefined or not provided, it is not included in the LoopBody output
 */

import { HarnessType } from "@repo/api/src/types/compute-target";
import { LoopCommand } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import type { LaunchDesktopOpts } from "../loop-desktop";
import { buildDesktopLoopExecutionBody } from "../loop-desktop";

// Minimal ContextPack required to call buildDesktopLoopExecutionBody
const baseContextPack: LaunchDesktopOpts["contextPack"] = {
  command: LoopCommand.Execute,
  artifacts: [],
};

// Minimal required opts (omitting desktopUserIntentSignature per the function signature)
const baseOpts: Omit<LaunchDesktopOpts, "desktopUserIntentSignature"> = {
  loopId: "loop-1",
  organizationId: "org-1",
  command: LoopCommand.Execute,
  computeTargetId: "ct-1",
  closedLoopAuthToken: "tok-abc",
  apiBaseUrl: "https://api.example.com",
  contextPack: baseContextPack,
};

describe("buildDesktopLoopExecutionBody — harness field", () => {
  it.each([
    {
      description: "includes harness field when HarnessType.Claude is provided",
      harness: HarnessType.Claude,
      expectedHarness: HarnessType.Claude,
    },
    {
      description: "includes harness field when HarnessType.Codex is provided",
      harness: HarnessType.Codex,
      expectedHarness: HarnessType.Codex,
    },
  ])("$description", ({ harness, expectedHarness }) => {
    const body = buildDesktopLoopExecutionBody({ ...baseOpts, harness });

    expect(body).toMatchObject({ harness: expectedHarness });
  });

  it.each([
    {
      description: "omits harness field when harness is undefined",
      opts: { ...baseOpts, harness: undefined },
    },
    {
      description: "omits harness field when harness is not provided",
      opts: baseOpts,
    },
  ])("$description", ({ opts }) => {
    const body = buildDesktopLoopExecutionBody(opts);

    expect(body).not.toHaveProperty("harness");
  });
});
