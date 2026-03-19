/**
 * Unit tests for run-loop schema, command handler registry, default prompts,
 * and mapLoopCommand — covering the evaluate_prd command additions.
 *
 * mapLoopCommand uses a loose `string` parameter with a `default: null` branch,
 * so TypeScript cannot catch missing cases. These tests are the only safety net.
 */

import { LoopCommand } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import { runLoopSchema } from "@/app/artifacts/[id]/run-loop/validators";
import { getCommandHandler } from "@/lib/loops/loop-commands";
import { mapLoopCommand } from "@/lib/loops/loop-status-utils";

// ---------------------------------------------------------------------------
// runLoopSchema
// ---------------------------------------------------------------------------

describe("runLoopSchema command enum", () => {
  it("accepts evaluate_prd as a valid command", () => {
    const result = runLoopSchema.safeParse({ command: "evaluate_prd" });
    expect(result.success).toBe(true);
  });

  it("accepts all other known commands", () => {
    for (const command of ["plan", "execute", "request_changes", "decompose"]) {
      const result = runLoopSchema.safeParse({ command });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown command value", () => {
    const result = runLoopSchema.safeParse({ command: "unknown_command" });
    expect(result.success).toBe(false);
  });

  it("rejects the UPPER_CASE Prisma enum form", () => {
    const result = runLoopSchema.safeParse({ command: "EVALUATE_PRD" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getCommandHandler
// ---------------------------------------------------------------------------

describe("getCommandHandler(LoopCommand.EvaluatePrd)", () => {
  it("returns a defined handler", () => {
    const handler = getCommandHandler(LoopCommand.EvaluatePrd);
    expect(handler).toBeDefined();
  });

  it("has requiresRepo set to false", () => {
    const handler = getCommandHandler(LoopCommand.EvaluatePrd);
    expect(handler?.requiresRepo).toBe(false);
  });

  it("has requiresParent set to false", () => {
    const handler = getCommandHandler(LoopCommand.EvaluatePrd);
    expect(handler?.requiresParent).toBe(false);
  });

  it("has includePrimaryArtifact set to true", () => {
    const handler = getCommandHandler(LoopCommand.EvaluatePrd);
    expect(handler?.includePrimaryArtifact).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// mapLoopCommand — ONLY safety net for missing switch cases
// ---------------------------------------------------------------------------

describe("mapLoopCommand", () => {
  it('maps "EVALUATE_PRD" to "evaluate_prd"', () => {
    expect(mapLoopCommand("EVALUATE_PRD")).toBe("evaluate_prd");
  });

  it('maps "PLAN" to "plan"', () => {
    expect(mapLoopCommand("PLAN")).toBe("plan");
  });

  it('maps "EXECUTE" to "execute"', () => {
    expect(mapLoopCommand("EXECUTE")).toBe("execute");
  });

  it('maps "DECOMPOSE" to "decompose"', () => {
    expect(mapLoopCommand("DECOMPOSE")).toBe("decompose");
  });

  it('maps "CHAT" to "chat"', () => {
    expect(mapLoopCommand("CHAT")).toBe("chat");
  });

  it('maps "EXPLORE" to "explore"', () => {
    expect(mapLoopCommand("EXPLORE")).toBe("explore");
  });

  it('maps "REQUEST_CHANGES" to "request_changes"', () => {
    expect(mapLoopCommand("REQUEST_CHANGES")).toBe("request_changes");
  });

  it("returns null for an unknown command", () => {
    expect(mapLoopCommand("UNKNOWN_COMMAND")).toBeNull();
  });
});
