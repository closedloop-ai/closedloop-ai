import { type ChildProcess, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createScriptOutput,
  type ScriptWritable,
  writeScriptLine,
} from "../script-progress-output";

describe("writeScriptLine", () => {
  it("writes a newline-terminated record and resolves from the stream callback", async () => {
    const stream = deferredWritable();
    let resolved = false;

    const write = writeScriptLine(stream, "page 1").then(() => {
      resolved = true;
    });

    await Promise.resolve();

    expect(stream.chunks).toStrictEqual(["page 1\n"]);
    expect(resolved).toBe(false);

    stream.resolveNextWrite();
    await write;

    expect(resolved).toBe(true);
  });

  it("rejects when the stream reports a write failure", async () => {
    const stream = deferredWritable();
    const write = writeScriptLine(stream, "page 1");

    stream.resolveNextWrite(new Error("pipe closed"));

    await expect(write).rejects.toThrow("pipe closed");
  });
});

describe("createScriptOutput", () => {
  it("routes log output to stdout and warnings/errors to stderr", async () => {
    const stdout = deferredWritable();
    const stderr = deferredWritable();
    const output = createScriptOutput({ stdout, stderr });

    const log = output.log("hello %s", "stdout");
    const warn = output.warn("hello %s", "warning");
    const error = output.error(new Error("boom"));

    expect(stdout.chunks).toStrictEqual(["hello stdout\n"]);
    expect(stderr.chunks).toHaveLength(2);
    expect(stderr.chunks[0]).toBe("hello warning\n");
    expect(stderr.chunks[1]).toContain("Error: boom");

    stdout.resolveNextWrite();
    stderr.resolveNextWrite();
    stderr.resolveNextWrite();

    await expect(Promise.all([log, warn, error])).resolves.toStrictEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("delivers a child-process stdout pipe line before the child exits", async () => {
    const moduleUrl = new URL("../script-progress-output.ts", import.meta.url);
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `import { scriptOutput } from ${JSON.stringify(moduleUrl.href)};`,
          'await scriptOutput.log("pipe-progress-ready");',
          "setTimeout(() => process.exit(0), 250);",
        ].join("\n"),
      ],
      {
        env: { ...process.env, NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    try {
      const observation = await waitForStdout(child, "pipe-progress-ready\n");

      expect(observation.output).toContain("pipe-progress-ready\n");
      expect(observation.exitedWhenObserved).toBe(false);
      await expect(waitForExit(child)).resolves.toStrictEqual({
        code: 0,
        signal: null,
      });
    } finally {
      if (child.exitCode === null && !child.killed) {
        child.kill("SIGTERM");
      }
    }
  });
});

function deferredWritable() {
  const callbacks: ((error?: Error | null) => void)[] = [];
  return {
    chunks: [] as string[],
    resolveNextWrite(error?: Error | null) {
      const callback = callbacks.shift();
      if (!callback) {
        throw new Error("expected a pending write callback");
      }
      callback(error);
    },
    write(chunk: string, callback: (error?: Error | null) => void) {
      this.chunks.push(chunk);
      callbacks.push(callback);
      return false;
    },
  } satisfies ScriptWritable & {
    chunks: string[];
    resolveNextWrite: (error?: Error | null) => void;
  };
}

function waitForStdout(
  child: ChildProcess,
  expected: string
): Promise<{ output: string; exitedWhenObserved: boolean }> {
  const stdout = requirePipe(child.stdout, "stdout");
  const stderr = requirePipe(child.stderr, "stderr");
  let output = "";
  let errorOutput = "";
  let exited = false;

  child.once("exit", () => {
    exited = true;
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for stdout; stderr=${errorOutput}`));
    }, 2000);

    const cleanup = () => {
      clearTimeout(timeout);
      stdout.off("data", onStdout);
      stderr.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
    };

    const onStdout = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (output.includes(expected)) {
        const exitedWhenObserved = exited;
        cleanup();
        resolve({ output, exitedWhenObserved });
      }
    };
    const onStderr = (chunk: Buffer) => {
      errorOutput += chunk.toString("utf8");
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!output.includes(expected)) {
        cleanup();
        reject(
          new Error(
            `child exited before stdout arrived; code=${code}, signal=${signal}, stderr=${errorOutput}`
          )
        );
      }
    };

    stdout.on("data", onStdout);
    stderr.on("data", onStderr);
    child.on("error", onError);
    child.on("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcess
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: null });
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for child exit"));
    }, 2000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({ code, signal });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    child.on("exit", onExit);
    child.on("error", onError);
  });
}

function requirePipe(stream: Readable | null, name: string): Readable {
  if (!stream) {
    throw new Error(`expected piped child ${name}`);
  }
  return stream;
}
