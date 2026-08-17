import { describe, expect, it } from "vitest";
import { shellCommand, shellCommandArgv } from "./parser-utils";
import type { NormalizedToolUse } from "./types";

// Helper — build a minimal NormalizedToolUse with the given input.
// Lives in module scope (not in test helpers file) so no separate fixture module.
function makeTool(input: unknown): NormalizedToolUse {
  return { name: "Bash", timestamp: null, input };
}

// ---------------------------------------------------------------------------
// shellCommand — lines 578-602
// ---------------------------------------------------------------------------

describe("shellCommand — no input (line 580, branch 97[0])", () => {
  it("returns empty string when input is undefined", () => {
    expect(shellCommand(makeTool(undefined))).toBe("");
  });

  it("returns empty string when input is null (null is falsy)", () => {
    expect(shellCommand(makeTool(null))).toBe("");
  });
});

describe("shellCommand — plain string input (line 583, branch 98[0])", () => {
  it("returns the string directly when input is a bare string", () => {
    expect(shellCommand(makeTool("git status"))).toBe("git status");
  });

  it("preserves whitespace inside a string command", () => {
    expect(shellCommand(makeTool("  ls  -la  "))).toBe("  ls  -la  ");
  });
});

describe("shellCommand — array input (line 586, branch 99[0])", () => {
  it("joins a string array with spaces", () => {
    expect(shellCommand(makeTool(["git", "push", "--force"]))).toBe(
      "git push --force"
    );
  });

  it("joins a single-element array", () => {
    expect(shellCommand(makeTool(["pwd"]))).toBe("pwd");
  });
});

describe("shellCommand — input.command string (line 589, branch 100[0])", () => {
  it("returns input.command when it is a string", () => {
    expect(shellCommand(makeTool({ command: "ls -la" }))).toBe("ls -la");
  });
});

describe("shellCommand — input.command array (line 592, branch 101[0])", () => {
  it("joins input.command array with spaces", () => {
    expect(shellCommand(makeTool({ command: ["npm", "run", "build"] }))).toBe(
      "npm run build"
    );
  });
});

describe("shellCommand — input.cmd string (line 595, branch 102[0])", () => {
  it("returns input.cmd when it is a string and command is absent", () => {
    expect(shellCommand(makeTool({ cmd: "pwd" }))).toBe("pwd");
  });
});

describe("shellCommand — input.cmd array (line 598, branch 103[0])", () => {
  it("joins input.cmd array with spaces", () => {
    expect(shellCommand(makeTool({ cmd: ["echo", "hello"] }))).toBe(
      "echo hello"
    );
  });
});

describe("shellCommand — no command field fallthrough (line 601, all false branches)", () => {
  it("returns empty string when input has neither command nor cmd", () => {
    expect(shellCommand(makeTool({ unrelated: "value" }))).toBe("");
  });

  it("returns empty string when command field is a number (not a string/array)", () => {
    expect(shellCommand(makeTool({ command: 42 }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// shellCommandArgv — lines 620-643
// Covers coerceArgvElement (private) via argv mapping.
// ---------------------------------------------------------------------------

describe("shellCommandArgv — no input or string input (line 624, branch 106[0])", () => {
  it("returns null when input is undefined", () => {
    expect(shellCommandArgv(makeTool(undefined))).toBeNull();
  });

  it("returns null when input is null (falsy → early null)", () => {
    expect(shellCommandArgv(makeTool(null))).toBeNull();
  });

  it("returns null when input is a plain string (not argv-shaped)", () => {
    // A string command like "git status" has no argument boundaries
    expect(shellCommandArgv(makeTool("git status"))).toBeNull();
  });
});

describe("shellCommandArgv — array input (line 627, branch 108[0])", () => {
  it("returns the input array mapped to strings when input is an array", () => {
    expect(shellCommandArgv(makeTool(["git", "push"]))).toEqual([
      "git",
      "push",
    ]);
  });

  it("preserves all elements including flags", () => {
    expect(
      shellCommandArgv(makeTool(["npm", "--prefix", "apps/app", "test"]))
    ).toEqual(["npm", "--prefix", "apps/app", "test"]);
  });
});

describe("shellCommandArgv — input.command string (line 630, branch 109[0])", () => {
  it("returns null when input.command is a string (not argv)", () => {
    expect(shellCommandArgv(makeTool({ command: "ls -la" }))).toBeNull();
  });
});

describe("shellCommandArgv — input.command array (line 633, branch 110[0])", () => {
  it("returns input.command mapped to strings when it is an array", () => {
    expect(shellCommandArgv(makeTool({ command: ["ls", "-la"] }))).toEqual([
      "ls",
      "-la",
    ]);
  });
});

describe("shellCommandArgv — input.cmd string (line 636, branch 111[0])", () => {
  it("returns null when input.cmd is a string (not argv)", () => {
    expect(shellCommandArgv(makeTool({ cmd: "pwd" }))).toBeNull();
  });
});

describe("shellCommandArgv — input.cmd array (line 639, branch 112[0])", () => {
  it("returns input.cmd mapped to strings when it is an array", () => {
    expect(shellCommandArgv(makeTool({ cmd: ["echo", "hello"] }))).toEqual([
      "echo",
      "hello",
    ]);
  });
});

describe("shellCommandArgv — no command field (line 642, final null)", () => {
  it("returns null when input has neither command nor cmd field", () => {
    expect(shellCommandArgv(makeTool({ unrelated: "value" }))).toBeNull();
  });

  it("returns null when command field is a number (not string/array)", () => {
    expect(shellCommandArgv(makeTool({ command: 99 }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// coerceArgvElement — exercised through shellCommandArgv (lines 616-618)
// null/undefined → "", everything else → String(element)
// ---------------------------------------------------------------------------

describe("coerceArgvElement (via shellCommandArgv) — null/undefined → ''", () => {
  it("coerces null argv elements to empty string (matching join(' ') behavior)", () => {
    // join(" ") renders null as "" — coerceArgvElement mirrors that
    const argv = shellCommandArgv(makeTool({ command: [null, "foo"] }));
    expect(argv).toEqual(["", "foo"]);
  });

  it("coerces undefined argv elements to empty string", () => {
    const argv = shellCommandArgv(makeTool({ command: [undefined, "bar"] }));
    expect(argv).toEqual(["", "bar"]);
  });

  it("String()-coerces a number argv element (not null/undefined → String() path)", () => {
    const argv = shellCommandArgv(makeTool({ command: [42, "args"] }));
    expect(argv).toEqual(["42", "args"]);
  });

  it("String()-coerces a boolean argv element", () => {
    const argv = shellCommandArgv(makeTool({ cmd: [true, "flag"] }));
    expect(argv).toEqual(["true", "flag"]);
  });
});
