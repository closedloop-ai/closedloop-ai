import { describe, expect, it } from "vitest";
import {
  applyTokenEdits,
  StyleLabExportError,
  StyleTokenOperation,
  StyleTokenScope,
  TARGET_FILE,
  validatePayload,
} from "./style-lab-export.mjs";

// A stand-in for packages/design-system/styles/globals.css. The apply core takes
// the stylesheet as a string, so every guard below is exercised against this
// fixture and the real design-system file is never touched by the suite.
const GLOBALS_FIXTURE = `@import "tailwindcss";

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
}

@theme inline {
  --color-background: var(--background);
  --text-lg: 1.125rem;
}

.trailing { color: red; }
`;

const UNEXPECTED_FILE = /unexpected file/;
const INVALID_TOKEN_NAME = /invalid token name/;
const MISSING_PREVIOUS_VALUE = /missing previousValue/;
const UNSUPPORTED_SCOPE = /unsupported scope/;
const EMPTY_VALUE = /empty value/;
const UNSAFE_DELIMITERS = /unsafe CSS delimiters/;
const COMMENT_DELIMITERS = /CSS comment delimiters/;
const COMMENT_DELIMITERS_IN_PREVIOUS =
  /CSS comment delimiters in previousValue/;
const MISSING_TOKEN_IN_ROOT =
  /--not-a-real-token was not found in the :root block/;
const MISSING_TOKEN_IN_THEME =
  /--radius was not found in the @theme inline block/;
const STALE_CURRENT_VALUE =
  /changed since export\. Expected "0\.5rem", found "0\.625rem"/;

function payloadWith(overrides = {}, tokenOverrides = {}) {
  return {
    version: 1,
    targetFile: TARGET_FILE,
    tokens: [
      {
        name: "radius",
        value: "0.75rem",
        previousValue: "0.625rem",
        scope: StyleTokenScope.Root,
        ...tokenOverrides,
      },
    ],
    ...overrides,
  };
}

describe("validatePayload", () => {
  it("accepts a well-formed export", () => {
    expect(validatePayload(payloadWith())).toEqual([
      {
        name: "radius",
        operation: StyleTokenOperation.Update,
        previousValue: "0.625rem",
        value: "0.75rem",
        scope: StyleTokenScope.Root,
      },
    ]);
  });

  // Guard 1: target file.
  it("rejects an export aimed at any file other than the design-system globals", () => {
    expect(() =>
      validatePayload(payloadWith({ targetFile: "packages/database/.env" }))
    ).toThrow(StyleLabExportError);
    expect(() =>
      validatePayload(payloadWith({ targetFile: "packages/database/.env" }))
    ).toThrow(UNEXPECTED_FILE);
  });

  // Guard 2: token name.
  it.each([
    ["a path traversal", "../../etc/passwd"],
    ["a CSS escape", "radius: red; --other"],
    ["an uppercase name outside the charset", "Radius"],
    ["a non-string name", 42],
  ])("rejects %s as a token name", (_label, name) => {
    expect(() => validatePayload(payloadWith({}, { name }))).toThrow(
      INVALID_TOKEN_NAME
    );
  });

  // Guard 3: previousValue present.
  it.each([
    ["absent", undefined],
    ["blank", "   "],
    ["a non-string", 3],
  ])("rejects an export whose previousValue is %s", (_label, previousValue) => {
    expect(() => validatePayload(payloadWith({}, { previousValue }))).toThrow(
      MISSING_PREVIOUS_VALUE
    );
  });

  // Guard 4: scope.
  it("rejects an unsupported scope", () => {
    expect(() => validatePayload(payloadWith({}, { scope: "html" }))).toThrow(
      UNSUPPORTED_SCOPE
    );
  });

  it("defaults an absent scope to root", () => {
    const [token] = validatePayload(payloadWith({}, { scope: undefined }));
    expect(token.scope).toBe(StyleTokenScope.Root);
  });

  it("rejects an empty value", () => {
    expect(() => validatePayload(payloadWith({}, { value: "  " }))).toThrow(
      EMPTY_VALUE
    );
  });

  it.each([
    ["a semicolon", "red; --admin: leaked"],
    ["a brace", "red } .evil {"],
  ])("rejects %s in a value", (_label, value) => {
    expect(() => validatePayload(payloadWith({}, { value }))).toThrow(
      UNSAFE_DELIMITERS
    );
  });

  // T2: CSS comment delimiters. `red /*` passes the [;{}] delimiter check and
  // would be written as `--radius: red /*;`, commenting out the remainder of
  // globals.css.
  it.each([
    ["an opener", "red /*"],
    ["a closer", "red */"],
    ["a wrapped comment", "red /* hi */"],
  ])("rejects %s in a value", (_label, value) => {
    expect(() => validatePayload(payloadWith({}, { value }))).toThrow(
      COMMENT_DELIMITERS
    );
  });

  it("rejects a CSS comment delimiter in previousValue", () => {
    expect(() =>
      validatePayload(payloadWith({}, { previousValue: "0.625rem /*" }))
    ).toThrow(COMMENT_DELIMITERS_IN_PREVIOUS);
  });

  it("still accepts a slash that is not a comment delimiter", () => {
    const [token] = validatePayload(
      payloadWith(
        {},
        {
          name: "background",
          value: "oklch(0.5 0.1 200 / 0.5)",
          previousValue: "oklch(1 0 0)",
        }
      )
    );
    expect(token.value).toBe("oklch(0.5 0.1 200 / 0.5)");
  });

  it("accepts add operations without previousValue", () => {
    const [token] = validatePayload(
      payloadWith(
        {},
        {
          name: "brand-new",
          operation: StyleTokenOperation.Add,
          previousValue: undefined,
          value: "oklch(0.5 0.1 200)",
        }
      )
    );
    expect(token).toEqual({
      name: "brand-new",
      operation: StyleTokenOperation.Add,
      previousValue: null,
      scope: StyleTokenScope.Root,
      value: "oklch(0.5 0.1 200)",
    });
  });

  it("accepts remove operations without value", () => {
    const [token] = validatePayload(
      payloadWith(
        {},
        {
          operation: StyleTokenOperation.Remove,
          value: undefined,
        }
      )
    );
    expect(token).toEqual({
      name: "radius",
      operation: StyleTokenOperation.Remove,
      previousValue: "0.625rem",
      scope: StyleTokenScope.Root,
      value: null,
    });
  });
});

describe("applyTokenEdits", () => {
  it("rewrites only the targeted declaration", () => {
    const next = applyTokenEdits(
      GLOBALS_FIXTURE,
      validatePayload(payloadWith())
    );
    expect(next).toContain("--radius: 0.75rem;");
    expect(next).toContain("--background: oklch(1 0 0);");
    expect(next).toContain(".trailing { color: red; }");
  });

  it("edits a token in the @theme inline scope", () => {
    const next = applyTokenEdits(
      GLOBALS_FIXTURE,
      validatePayload(
        payloadWith(
          {},
          {
            name: "text-lg",
            value: "1.25rem",
            previousValue: "1.125rem",
            scope: StyleTokenScope.Theme,
          }
        )
      )
    );
    expect(next).toContain("--text-lg: 1.25rem;");
  });

  it("adds a token to the addressed scope", () => {
    const next = applyTokenEdits(
      GLOBALS_FIXTURE,
      validatePayload(
        payloadWith(
          {},
          {
            name: "brand-new",
            operation: StyleTokenOperation.Add,
            previousValue: undefined,
            value: "oklch(0.5 0.1 200)",
          }
        )
      )
    );
    expect(next).toContain("--brand-new: oklch(0.5 0.1 200);");
    expect(next).toContain(".trailing { color: red; }");
  });

  it("removes a token from the addressed scope", () => {
    const next = applyTokenEdits(
      GLOBALS_FIXTURE,
      validatePayload(
        payloadWith(
          {},
          {
            operation: StyleTokenOperation.Remove,
            value: undefined,
          }
        )
      )
    );
    expect(next).not.toContain("--radius:");
    expect(next).toContain("--background: oklch(1 0 0);");
  });

  // Guard 5: the token must exist in the addressed block.
  it("rejects a token that is absent from the addressed block", () => {
    const tokens = validatePayload(
      payloadWith({}, { name: "not-a-real-token", previousValue: "1rem" })
    );
    expect(() => applyTokenEdits(GLOBALS_FIXTURE, tokens)).toThrow(
      MISSING_TOKEN_IN_ROOT
    );
  });

  it("rejects a root token addressed against the theme scope", () => {
    const tokens = validatePayload(
      payloadWith({}, { scope: StyleTokenScope.Theme })
    );
    expect(() => applyTokenEdits(GLOBALS_FIXTURE, tokens)).toThrow(
      MISSING_TOKEN_IN_THEME
    );
  });

  // Guard 6: the on-disk value must still match what the export was taken from.
  it("rejects a stale export whose previousValue no longer matches the file", () => {
    const tokens = validatePayload(
      payloadWith({}, { previousValue: "0.5rem" })
    );
    expect(() => applyTokenEdits(GLOBALS_FIXTURE, tokens)).toThrow(
      STALE_CURRENT_VALUE
    );
  });

  it("leaves the stylesheet untouched when a later edit in the batch fails", () => {
    const tokens = validatePayload({
      version: 1,
      targetFile: TARGET_FILE,
      tokens: [
        {
          name: "radius",
          value: "0.75rem",
          previousValue: "0.625rem",
          scope: StyleTokenScope.Root,
        },
        {
          name: "foreground",
          value: "oklch(0 0 0)",
          previousValue: "stale",
          scope: StyleTokenScope.Root,
        },
      ],
    });
    expect(() => applyTokenEdits(GLOBALS_FIXTURE, tokens)).toThrow(
      StyleLabExportError
    );
  });
});
