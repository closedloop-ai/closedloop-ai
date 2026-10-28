import { AGENTS_DETAIL_HONESTY_FLAG_KEY } from "@repo/api/src/types/agents-detail-honesty-flag";
import { describe, expect, it } from "vitest";
import { AGENT_BREADCRUMB_HONESTY_PARITY } from "../agent-breadcrumb-honesty-parity";

const HEX_DIGEST_PATTERN = /^[0-9a-f]+$/;

describe("AGENT_BREADCRUMB_HONESTY_PARITY", () => {
  it("is keyed to the real agents-detail-honesty flag, not a re-typed literal", () => {
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.flagKey).toBe(
      AGENTS_DETAIL_HONESTY_FLAG_KEY
    );
  });

  it("names a non-empty component name and hash slug", () => {
    expect(
      AGENT_BREADCRUMB_HONESTY_PARITY.componentName.length
    ).toBeGreaterThan(0);
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.hashSlug.length).toBeGreaterThan(0);
  });

  it("uses a content-hash slug shape (a `::` separator with a hex digest suffix)", () => {
    const [, digest] = AGENT_BREADCRUMB_HONESTY_PARITY.hashSlug.split("::");

    expect(digest).toMatch(HEX_DIGEST_PATTERN);
  });

  it("pins both surfaces to the resolved component name when the flag is on", () => {
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.flagOn.web).toBe(
      AGENT_BREADCRUMB_HONESTY_PARITY.componentName
    );
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.flagOn.desktop).toBe(
      AGENT_BREADCRUMB_HONESTY_PARITY.componentName
    );
  });

  it("pins the documented divergence when the flag is off: web falls back, desktop does not", () => {
    // Web gates the resolved name behind the flag and falls back to the neutral
    // "Agent" crumb; desktop reads no such flag and keeps the resolved name.
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.flagOff.web).toBe("Agent");
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.flagOff.desktop).toBe(
      AGENT_BREADCRUMB_HONESTY_PARITY.componentName
    );
  });

  it("flagOff.web differs from flagOff.desktop, which is the divergence this fixture records", () => {
    expect(AGENT_BREADCRUMB_HONESTY_PARITY.flagOff.web).not.toBe(
      AGENT_BREADCRUMB_HONESTY_PARITY.flagOff.desktop
    );
  });
});
