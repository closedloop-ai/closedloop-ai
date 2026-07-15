import { describe, expect, it } from "vitest";
import {
  classifyComponentPath,
  dedupeComponents,
  isComponentCandidatePath,
} from "../pack-component-parse";

describe("isComponentCandidatePath", () => {
  it("accepts recognized component paths (any prefix)", () => {
    for (const path of [
      "agents/a.md",
      "nested/commands/c.md",
      "skills/plan/SKILL.md",
      "skills/flat.md",
      "hooks/h.json",
      "hooks.json",
      ".mcp.json",
      "sub/.mcp.json",
    ]) {
      expect(isComponentCandidatePath(path)).toBe(true);
    }
  });

  it("accepts namespaced (subdirectory) command/agent paths", () => {
    for (const path of [
      "commands/git/commit.md",
      "agents/team/name.md",
      "nested/commands/a/b/c.md",
      ".claude/agents/frontend/reviewer.md",
    ]) {
      expect(isComponentCandidatePath(path)).toBe(true);
    }
  });

  it("rejects non-component paths", () => {
    for (const path of ["README.md", "src/index.ts", "agents/notes.txt"]) {
      expect(isComponentCandidatePath(path)).toBe(false);
    }
  });

  it("rejects non-hook .json under agents/commands/skills (classifies to null)", () => {
    // These are NOT components (only `.md` is a component under these dirs), so
    // they must not be candidates — otherwise they waste a blob fetch and can
    // evict real components from the fetch cap. See FEA-3192.
    for (const path of [
      "agents/foo.json",
      "commands/foo.json",
      "skills/foo.json",
      "nested/agents/fixture.json",
    ]) {
      expect(isComponentCandidatePath(path)).toBe(false);
      expect(classifyComponentPath(path, () => "{}")).toBeNull();
    }
  });

  it("still accepts hook/mcp json and .md across component dirs", () => {
    for (const path of [
      "hooks/x.json",
      "hooks.json",
      "mcp.json",
      ".mcp.json",
      "sub/hooks/x.json",
      "agents/a.md",
      "commands/c.md",
      "skills/flat.md",
    ]) {
      expect(isComponentCandidatePath(path)).toBe(true);
    }
  });
});

describe("classifyComponentPath", () => {
  it("reads content lazily only for a match", () => {
    const parsed = classifyComponentPath("agents/x.md", () => "body");
    expect(parsed).toEqual([{ kind: "agent", name: "x", content: "body" }]);
    expect(classifyComponentPath("README.md", () => "x")).toBeNull();
  });

  it("classifies direct-child commands/agents with the bare name", () => {
    expect(classifyComponentPath("commands/foo.md", () => "c")).toEqual([
      { kind: "command", name: "foo", content: "c" },
    ]);
    expect(classifyComponentPath("agents/bar.md", () => "a")).toEqual([
      { kind: "agent", name: "bar", content: "a" },
    ]);
  });

  it("classifies a prefixed (non-namespaced) command dir", () => {
    expect(classifyComponentPath("nested/commands/c.md", () => "x")).toEqual([
      { kind: "command", name: "c", content: "x" },
    ]);
  });

  it("classifies namespaced subdirectory commands as `<ns>:<cmd>`", () => {
    expect(classifyComponentPath("commands/git/commit.md", () => "x")).toEqual([
      { kind: "command", name: "git:commit", content: "x" },
    ]);
  });

  it("classifies namespaced subdirectory agents as `<team>:<name>`", () => {
    expect(classifyComponentPath("agents/team/name.md", () => "x")).toEqual([
      { kind: "agent", name: "team:name", content: "x" },
    ]);
  });

  it("colon-joins a deeper command/agent namespace", () => {
    expect(classifyComponentPath("commands/a/b/c.md", () => "x")).toEqual([
      { kind: "command", name: "a:b:c", content: "x" },
    ]);
    expect(classifyComponentPath(".claude/agents/x/y/z.md", () => "x")).toEqual(
      [{ kind: "agent", name: "x:y:z", content: "x" }]
    );
  });

  it("still classifies prefixed namespaced commands (root folder tolerated)", () => {
    expect(
      classifyComponentPath("nested/commands/git/commit.md", () => "x")
    ).toEqual([{ kind: "command", name: "git:commit", content: "x" }]);
  });

  it("does not treat a file literally named `commands` as a component", () => {
    expect(classifyComponentPath("some/commands", () => "x")).toBeNull();
  });
});

describe("dedupeComponents", () => {
  it("keeps the first of each kind+name (case-insensitive)", () => {
    const deduped = dedupeComponents([
      { kind: "agent", name: "Dup", content: "1" },
      { kind: "agent", name: "dup", content: "2" },
      { kind: "skill", name: "Dup", content: "3" },
    ]);
    expect(deduped).toHaveLength(2);
    expect(deduped[0].content).toBe("1");
  });
});
