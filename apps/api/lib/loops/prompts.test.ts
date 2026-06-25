/**
 * Unit tests for `buildLoopPrompt` — the single composer that produces the
 * final prompt for a loop spawn. Composes (custom body | command default)
 * with an optional peer-repo preamble.
 *
 * Covers:
 * - PLN-461 AC-002 (byte-equality on empty/undefined peers)
 * - REQUEST_PRD_CHANGES peer-awareness fix (preamble layered on top of the
 *   user-supplied amend message)
 * - GENERATE_PRD with a custom body prompt + peers (preamble layered on top
 *   of the custom body)
 * - DECOMPOSE returns its instructions and ignores peers
 * - Commands without peer awareness return the body / "" unchanged regardless
 *   of `additionalRepos`
 */

import { LoopCommand } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import { buildLoopPrompt } from "./prompts";

const PEERS = [
  { fullName: "org/peer-a", branch: "main" },
  { fullName: "org/peer-b", branch: "develop" },
];

const PREAMBLE_HEADING = "## Additional repositories (peer mounts)";
const TRUST_BOUNDARY_HEADING = "## Untrusted Input Handling";
const SEPARATOR = "\n---\n\n";

const PRD_INSTRUCTIONS_FIRST_LINE =
  "You are an expert product manager who creates comprehensive Product Requirements Documents";

describe("buildLoopPrompt", () => {
  describe("GENERATE_PRD", () => {
    it("with no body and no peers returns the legacy default instructions byte-for-byte (AC-002)", () => {
      const prompt = buildLoopPrompt(LoopCommand.GeneratePrd);
      expect(prompt).not.toContain(PREAMBLE_HEADING);
      expect(prompt).toContain(TRUST_BOUNDARY_HEADING);
      expect(prompt).toContain(PRD_INSTRUCTIONS_FIRST_LINE);
    });

    it("with no body and an empty peer array returns the same baseline (AC-002)", () => {
      const baseline = buildLoopPrompt(LoopCommand.GeneratePrd);
      expect(buildLoopPrompt(LoopCommand.GeneratePrd, undefined, [])).toBe(
        baseline
      );
    });

    it("with no body and peers prepends the peer preamble before the default instructions", () => {
      const baseline = buildLoopPrompt(LoopCommand.GeneratePrd);
      const withPeers = buildLoopPrompt(
        LoopCommand.GeneratePrd,
        undefined,
        PEERS
      );
      expect(withPeers.startsWith(PREAMBLE_HEADING)).toBe(true);
      expect(withPeers).toContain(TRUST_BOUNDARY_HEADING);
      expect(withPeers).toContain("`org/peer-a` @ `main`");
      expect(withPeers).toContain("`org/peer-b` @ `develop`");
      const separatorIdx = withPeers.indexOf(SEPARATOR);
      expect(separatorIdx).toBeGreaterThan(0);
      expect(withPeers.slice(separatorIdx + SEPARATOR.length)).toBe(baseline);
    });

    it("with a custom body and no peers prepends the trust-boundary preamble", () => {
      const body = "Custom GENERATE_PRD instructions for this loop.";
      expect(buildLoopPrompt(LoopCommand.GeneratePrd, body)).toContain(body);
      expect(buildLoopPrompt(LoopCommand.GeneratePrd, body)).toContain(
        TRUST_BOUNDARY_HEADING
      );
      expect(buildLoopPrompt(LoopCommand.GeneratePrd, body, [])).toContain(
        body
      );
    });

    it("with a custom body and peers prepends the peer preamble to the custom body", () => {
      const body = "Custom GENERATE_PRD instructions for this loop.";
      const prompt = buildLoopPrompt(LoopCommand.GeneratePrd, body, PEERS);
      expect(prompt.startsWith(PREAMBLE_HEADING)).toBe(true);
      expect(prompt).toContain(TRUST_BOUNDARY_HEADING);
      expect(prompt.endsWith(body)).toBe(true);
      const separatorIdx = prompt.indexOf(SEPARATOR);
      const trailingPrompt = prompt.slice(separatorIdx + SEPARATOR.length);
      expect(trailingPrompt).toContain(TRUST_BOUNDARY_HEADING);
      expect(trailingPrompt).toContain(body);
    });
  });

  describe("REQUEST_PRD_CHANGES", () => {
    it("without a meaningful body returns an empty prompt unchanged so validation can still reject it", () => {
      const prompt = buildLoopPrompt(
        LoopCommand.RequestPrdChanges,
        undefined,
        PEERS
      );

      expect(prompt).toBe("");
      expect(prompt).not.toContain(PREAMBLE_HEADING);
      expect(prompt).not.toContain(TRUST_BOUNDARY_HEADING);
    });

    it("with a whitespace-only body preserves the blank prompt instead of prepending preambles", () => {
      const prompt = buildLoopPrompt(
        LoopCommand.RequestPrdChanges,
        "   ",
        PEERS
      );

      expect(prompt).toBe("   ");
      expect(prompt).not.toContain(PREAMBLE_HEADING);
      expect(prompt).not.toContain(TRUST_BOUNDARY_HEADING);
    });

    it("with a body and no peers prepends the trust-boundary preamble", () => {
      const body = "Please rephrase the goals section.";
      expect(buildLoopPrompt(LoopCommand.RequestPrdChanges, body)).toContain(
        body
      );
      expect(buildLoopPrompt(LoopCommand.RequestPrdChanges, body)).toContain(
        TRUST_BOUNDARY_HEADING
      );
      expect(
        buildLoopPrompt(LoopCommand.RequestPrdChanges, body, [])
      ).toContain(body);
    });

    it("with a body and peers prepends the peer preamble to the body — fixes the inheritance bug", () => {
      const body = "Please rephrase the goals section.";
      const prompt = buildLoopPrompt(
        LoopCommand.RequestPrdChanges,
        body,
        PEERS
      );
      expect(prompt.startsWith(PREAMBLE_HEADING)).toBe(true);
      expect(prompt).toContain(TRUST_BOUNDARY_HEADING);
      expect(prompt).toContain("`org/peer-a` @ `main`");
      expect(prompt.endsWith(body)).toBe(true);
      const separatorIdx = prompt.indexOf(SEPARATOR);
      const trailingPrompt = prompt.slice(separatorIdx + SEPARATOR.length);
      expect(trailingPrompt).toContain(TRUST_BOUNDARY_HEADING);
      expect(trailingPrompt).toContain(body);
    });

    it("singularizes 'repository' for exactly one peer", () => {
      const prompt = buildLoopPrompt(
        LoopCommand.RequestPrdChanges,
        "amend message",
        [{ fullName: "org/peer-a", branch: "main" }]
      );
      expect(prompt).toContain("1 read-only peer repository alongside");
      expect(prompt).not.toContain("1 read-only peer repositories");
    });

    it("pluralizes 'repositories' for multiple peers", () => {
      const prompt = buildLoopPrompt(
        LoopCommand.RequestPrdChanges,
        "amend message",
        PEERS
      );
      expect(prompt).toContain("2 read-only peer repositories alongside");
    });
  });

  describe("DECOMPOSE", () => {
    it("with no body returns the feature-decompose instructions and ignores peers", () => {
      const baseline = buildLoopPrompt(LoopCommand.Decompose);
      expect(baseline).toContain("decomposes Product Requirements Documents");
      expect(baseline).toContain(TRUST_BOUNDARY_HEADING);
      expect(baseline).not.toContain(PREAMBLE_HEADING);
      // DECOMPOSE has no peer awareness today — passing peers must not change
      // its output until that case is added to `getPeerPreamble`.
      expect(buildLoopPrompt(LoopCommand.Decompose, undefined, PEERS)).toBe(
        baseline
      );
    });

    it("with a custom body prepends the trust-boundary preamble and ignores peers", () => {
      const body = "Custom decompose instructions.";
      expect(buildLoopPrompt(LoopCommand.Decompose, body)).toContain(body);
      expect(buildLoopPrompt(LoopCommand.Decompose, body)).toContain(
        TRUST_BOUNDARY_HEADING
      );
      expect(buildLoopPrompt(LoopCommand.Decompose, body, PEERS)).toContain(
        body
      );
    });
  });

  describe("commands without prompt-side peer awareness", () => {
    // PLAN/EXECUTE handle peers via run-loop.sh + --add-dir at the runtime
    // layer, so the prompt-side preamble must not be duplicated for them.
    // CHAT/EXPLORE/evaluators/REQUEST_CHANGES/BOOTSTRAP have no peer support
    // at all today; passing peers must be a no-op.
    const commandsWithoutPreamble = [
      LoopCommand.Plan,
      LoopCommand.Execute,
      LoopCommand.Chat,
      LoopCommand.Explore,
      LoopCommand.EvaluatePrd,
      LoopCommand.EvaluatePlan,
      LoopCommand.EvaluateCode,
      LoopCommand.EvaluateFeature,
      LoopCommand.RequestChanges,
      LoopCommand.Bootstrap,
    ];

    for (const command of commandsWithoutPreamble) {
      it(`${command}: returns the body verbatim regardless of peers`, () => {
        const body = `body for ${command}`;
        expect(buildLoopPrompt(command, body)).toBe(body);
        expect(buildLoopPrompt(command, body, PEERS)).toBe(body);
      });

      it(`${command}: returns "" with no body regardless of peers`, () => {
        expect(buildLoopPrompt(command)).toBe("");
        expect(buildLoopPrompt(command, undefined, PEERS)).toBe("");
      });
    }
  });
});
