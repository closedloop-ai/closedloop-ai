import { describe, expect, it, vi } from "vitest";
import { SeedResetFailureReason } from "../../reset";
import { confirmResetIfNeeded } from "../../reset-confirmation";
import { BASELINE_ORG_ID, BASELINE_USER_ID } from "../fixtures/baseline-org";

describe("reset confirmation", () => {
  const tty = { isTTY: true };

  it("skips prompting when force is set", async () => {
    const question = vi.fn();
    await confirmResetIfNeeded({
      force: true,
      organizationId: BASELINE_ORG_ID,
      userId: BASELINE_USER_ID,
      targetSource: "explicit-flags",
      profile: "minimal",
      totalRows: 10,
      input: tty,
      output: tty,
      question,
      log: vi.fn(),
    });
    expect(question).not.toHaveBeenCalled();
  });

  it("accepts a case-insensitive UUID confirmation with surrounding whitespace", async () => {
    await expect(
      confirmResetIfNeeded({
        force: false,
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        targetSource: "explicit-flags",
        profile: "minimal",
        totalRows: 10,
        input: tty,
        output: tty,
        question: vi
          .fn()
          .mockResolvedValue(`  ${BASELINE_ORG_ID.toUpperCase()}  `),
        log: vi.fn(),
      })
    ).resolves.toBeUndefined();
  });

  it("fails non-TTY reset before asking for confirmation", async () => {
    const question = vi.fn();
    await expect(
      confirmResetIfNeeded({
        force: false,
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        targetSource: "explicit-flags",
        profile: "minimal",
        totalRows: 10,
        input: { isTTY: false },
        output: tty,
        question,
        log: vi.fn(),
      })
    ).rejects.toThrow(SeedResetFailureReason.ResetConfirmationRequired);
    expect(question).not.toHaveBeenCalled();
  });

  it("reports cancellation for a wrong confirmation before reset work is called", async () => {
    await expect(
      confirmResetIfNeeded({
        force: false,
        organizationId: BASELINE_ORG_ID,
        userId: BASELINE_USER_ID,
        targetSource: "explicit-flags",
        profile: "minimal",
        totalRows: 10,
        input: tty,
        output: tty,
        question: vi.fn().mockResolvedValue("wrong-org"),
        log: vi.fn(),
      })
    ).rejects.toThrow(SeedResetFailureReason.ResetCancelled);
  });
});
