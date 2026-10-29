import { describe, expect, it } from "vitest";
import {
  toAgentComponentKind,
  usageScopeHashForContent,
} from "./agent-component-usage-scope.js";
import { computeDefinitionHash } from "./definition-fingerprint.js";
import { AgentComponentKind } from "./types/agent-component.js";

describe("toAgentComponentKind", () => {
  it("keeps a known kind and coerces an unknown one to config", () => {
    expect(toAgentComponentKind(AgentComponentKind.Skill)).toBe(
      AgentComponentKind.Skill
    );
    expect(toAgentComponentKind("mystery")).toBe(AgentComponentKind.Config);
  });
});

describe("usageScopeHashForContent", () => {
  it("returns null only for null or undefined content", () => {
    expect(usageScopeHashForContent(null, AgentComponentKind.Skill)).toBeNull();
    expect(
      usageScopeHashForContent(undefined, AgentComponentKind.Skill)
    ).toBeNull();
  });

  it("hashes an empty body as a real revision", () => {
    expect(usageScopeHashForContent("", AgentComponentKind.Skill)).toBe(
      computeDefinitionHash({
        frontmatter: "",
        body: "",
        kind: AgentComponentKind.Skill,
      }).definitionHash
    );
  });

  it("scopes the digest by kind, hashing an unknown kind as config", () => {
    const skill = usageScopeHashForContent("body", AgentComponentKind.Skill);
    const config = usageScopeHashForContent("body", AgentComponentKind.Config);
    expect(skill).not.toBe(config);
    expect(usageScopeHashForContent("body", "mystery")).toBe(config);
  });
});
