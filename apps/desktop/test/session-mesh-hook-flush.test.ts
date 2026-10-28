import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";

it("does not send a receipt until the production handler stdout completion callback runs", () => {
  const requests: Array<{ hook_type: string }> = [];
  let releaseStdout: (() => void) | undefined;
  let output = "";
  const stdin = Object.assign(new EventEmitter(), {
    setEncoding: () => undefined,
  });
  const http = {
    request: (
      _options: unknown,
      callback: (response: EventEmitter & { setEncoding: () => void }) => void
    ) =>
      Object.assign(new EventEmitter(), {
        destroy: () => undefined,
        end: (body: string) => {
          requests.push(JSON.parse(body));
          const response = Object.assign(new EventEmitter(), {
            setEncoding: () => undefined,
          });
          callback(response);
          response.emit(
            "data",
            JSON.stringify({
              ok: true,
              additionalContext: "peer evidence",
              receipt: "receipt-id",
            })
          );
          response.emit("end");
        },
      }),
  };
  // Execute the real script, holding only its stdout completion boundary.
  runInNewContext(
    readFileSync(
      path.resolve("resources/hooks/session-mesh-hook-handler.js"),
      "utf8"
    ),
    {
      Buffer,
      setTimeout: () => ({ unref: () => undefined }),
      require: (name: string) => {
        if (name === "node:http") {
          return http;
        }
        if (name === "node:fs") {
          return { readFileSync: () => "a".repeat(64) };
        }
        if (name === "node:path") {
          return path;
        }
        throw new Error(`Unexpected handler dependency: ${name}`);
      },
      process: {
        argv: ["node", "/fixture/hook.js", "SessionStart", "codex"],
        env: {},
        stdin,
        stdout: {
          write: (text: string, complete: () => void) => {
            output += text;
            releaseStdout = complete;
          },
        },
        exit: () => undefined,
      },
    }
  );
  stdin.emit(
    "data",
    JSON.stringify({ session_id: "native-session", cwd: "/repo" })
  );
  stdin.emit("end");
  expect(JSON.parse(output).hookSpecificOutput.additionalContext).toBe(
    "peer evidence"
  );
  expect(releaseStdout).toBeTypeOf("function");
  expect(requests.map((request) => request.hook_type)).toEqual([
    "SessionStart",
  ]);
  releaseStdout?.();
  expect(requests.map((request) => request.hook_type)).toEqual([
    "SessionStart",
    "ContextDelivered",
  ]);
});
