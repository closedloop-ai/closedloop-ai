import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCAL_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function sessionMeshLocalToken(userDataPath: string): string {
  const directory = path.join(userDataPath, "session-mesh");
  const file = path.join(directory, "local-token");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(32).toString("hex"), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const token = readFileSync(file, "utf8").trim();
  if (!LOCAL_TOKEN_PATTERN.test(token)) {
    throw new Error("Session Mesh local credential is invalid");
  }
  return token;
}

export function matchesSessionMeshToken(
  expected: string,
  actual: unknown
): boolean {
  return (
    typeof actual === "string" &&
    Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
  );
}
