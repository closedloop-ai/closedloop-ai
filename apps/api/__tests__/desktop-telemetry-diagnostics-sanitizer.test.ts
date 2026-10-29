import { sanitizeDesktopTelemetryDiagnostics } from "@repo/observability/telemetry/emitter";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// (i) sanitizeDesktopTelemetryDiagnostics — stderrTail ANSI + credential filter
// ---------------------------------------------------------------------------

describe("sanitizeDesktopTelemetryDiagnostics — stderrTail sanitization", () => {
  it("strips ANSI codes and credential lines from stderrTail", () => {
    const diagnostics = {
      stderrTail:
        "\u001b[31mError: something failed\u001b[0m\nauthorization: Bearer sk_live_secret\nclean line here",
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.stderrTail).toBe("Error: something failed\nclean line here");
  });

  it("strips ANSI codes from logTail", () => {
    const diagnostics = {
      logTail: "\u001b[32mSuccess\u001b[0m output here",
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.logTail).toBe("Success output here");
  });

  it("handles diagnostics with both logTail and stderrTail containing ANSI", () => {
    const diagnostics = {
      logTail: "\u001b[34mInfo:\u001b[0m normal log\ntoken=abc123",
      stderrTail: "\u001b[31mError:\u001b[0m bad thing\npassword=secret",
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.logTail).toBe("Info: normal log");
    expect(result?.stderrTail).toBe("Error: bad thing");
  });
});

// ---------------------------------------------------------------------------
// (j) sanitizeDesktopTelemetryDiagnostics — spawnMeta.envSnapshot allowlist
// ---------------------------------------------------------------------------

describe("sanitizeDesktopTelemetryDiagnostics — envSnapshot filtering", () => {
  it("filters spawnMeta.envSnapshot to safe keys only", () => {
    const diagnostics = {
      spawnMeta: {
        command: "claude",
        args: ["--model", "opus"],
        cwd: "/home/user/project",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: true,
        envSnapshot: {
          NODE_ENV: "production",
          CLAUDE_CODE_USE_BEDROCK: "1",
          CLAUDE_CODE_USE_VERTEX: "0",
          AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
          DATABASE_URL: "postgresql://user:pass@host/db",
          HOME: "/home/user",
          PATH: "/usr/local/bin:/usr/bin",
        },
      },
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    const env = result?.spawnMeta?.envSnapshot;
    expect(env).toBeDefined();
    // Safe keys survive
    expect(env?.NODE_ENV).toBe("production");
    expect(env?.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env?.CLAUDE_CODE_USE_VERTEX).toBe("0");
    // Unsafe keys are stripped
    expect(env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(env).not.toHaveProperty("DATABASE_URL");
    expect(env).not.toHaveProperty("HOME");
    expect(env).not.toHaveProperty("PATH");
  });

  it("does not mutate the original diagnostics object", () => {
    const original = {
      spawnMeta: {
        command: "claude",
        args: [] as string[],
        cwd: "/tmp",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: false,
        envSnapshot: {
          NODE_ENV: "test",
          SECRET_KEY: "should-be-stripped",
        },
      },
    };

    sanitizeDesktopTelemetryDiagnostics(original);

    // Original still has the unsafe key
    expect(original.spawnMeta.envSnapshot.SECRET_KEY).toBe(
      "should-be-stripped"
    );
  });

  it("preserves spawnMeta fields and returns empty envSnapshot when no keys are safe", () => {
    const diagnostics = {
      spawnMeta: {
        command: "claude",
        args: ["--help"],
        cwd: "/tmp",
        binaryPath: "/usr/local/bin/claude",
        authFilesExist: true,
        envSnapshot: {
          SECRET_TOKEN: "should-be-stripped",
          PRIVATE_KEY: "also-stripped",
        },
      },
    };

    const result = sanitizeDesktopTelemetryDiagnostics(diagnostics);

    expect(result).toBeDefined();
    expect(result?.spawnMeta?.command).toBe("claude");
    expect(result?.spawnMeta?.envSnapshot).toEqual({});
  });
});
