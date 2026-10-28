/**
 * ISS-12168: every exported `*ErrorCode` object in the shared contract
 * packages is in the `request_completed` `error_code` set. A new one that is
 * not added to `REQUEST_ERROR_CODE_SOURCES` turns this red instead of being
 * dropped from the log.
 */
import { describe, expect, it } from "vitest";
import { readResponseErrorCode } from "@/lib/observability/request-error-code";

const contractModules = import.meta.glob([
  "../../../../packages/api/src/types/**/*.ts",
  "../../../../packages/loops-api/src/**/*.ts",
  "!**/*.test.ts",
  "!**/__tests__/**",
]);

const ERROR_CODE_EXPORT = /ErrorCode$/;

const loaded = await Promise.all(
  Object.entries(contractModules).map(async ([modulePath, load]) => {
    try {
      return { modulePath, imported: true, exports: await load() };
    } catch {
      return { modulePath, imported: false, exports: undefined };
    }
  })
);

const errorCodeObjects = loaded.flatMap(({ modulePath, exports }) =>
  Object.entries(typeof exports === "object" && exports !== null ? exports : {})
    .filter(
      (entry): entry is [string, Record<string, string>] =>
        ERROR_CODE_EXPORT.test(entry[0]) && isStringRecord(entry[1])
    )
    .map(([name, codes]) => ({ name, modulePath, codes }))
);

describe("request_completed error_code inventory (ISS-12168)", () => {
  it("imports every contract module", () => {
    const unimported = loaded
      .filter(({ imported }) => !imported)
      .map(({ modulePath }) => modulePath)
      .sort();

    expect(unimported).toEqual([]);
  });

  it("walks both contract packages", () => {
    const names = errorCodeObjects.map(({ name }) => name);

    expect(names).toContain("AuthErrorCode");
    expect(names).toContain("LoopErrorCode");
  });

  it.each(errorCodeObjects)(
    "$name ($modulePath) is in the error_code set",
    async ({ codes }) => {
      const missing: string[] = [];
      for (const code of Object.values(codes)) {
        const logged = await readResponseErrorCode(
          Response.json({ code }, { status: 403 })
        );
        if (logged !== code) {
          missing.push(code);
        }
      }

      expect(missing).toEqual([]);
    }
  );
});

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const values = Object.values(value);
  return values.length > 0 && values.every((item) => typeof item === "string");
}
