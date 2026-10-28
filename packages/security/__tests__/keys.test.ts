import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { keys } from "../keys";

const HTTPS_REPORT_URI =
  "https://csp-report.browser-intake-datadoghq.com/api/v2/logs";
const HTTP_REPORT_URI =
  "http://csp-report.browser-intake-datadoghq.com/api/v2/logs";

describe("packages/security keys", () => {
  const originals = new Map<string, string | undefined>();
  let consoleError: MockInstance;

  beforeEach(() => {
    for (const name of MANAGED_VARS) {
      originals.set(name, process.env[name]);
      Reflect.deleteProperty(process.env, name);
    }
    // t3-env's default validation handler prints the per-field issues and then
    // throws a generic `Invalid environment variables`. The console call is the
    // ONLY channel carrying which variable failed and why, so it is the contract
    // being asserted here, not incidental logging.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      // silence the expected validation report
    });
  });

  afterEach(() => {
    for (const [name, value] of originals) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, name);
      } else {
        process.env[name] = value;
      }
    }
    originals.clear();
    consoleError.mockRestore();
  });

  it("rejects an http:// report URI with the HTTPS refinement message", () => {
    process.env.CSP_REPORT_URI = HTTP_REPORT_URI;

    expect(() => keys()).toThrow("Invalid environment variables");
    expect(reportedIssues()).toContainEqual(
      expect.objectContaining({
        path: ["CSP_REPORT_URI"],
        message: "CSP_REPORT_URI must use HTTPS",
      })
    );
  });

  // The control for the case above: same variable, same shape, only the scheme
  // differs. Without it, the throw could be coming from anything ambient.
  it("accepts an https:// intake report URI and returns it verbatim", () => {
    process.env.CSP_REPORT_URI = HTTPS_REPORT_URI;

    expect(keys().CSP_REPORT_URI).toBe(HTTPS_REPORT_URI);
    expect(consoleError).not.toHaveBeenCalled();
  });

  // A bare `https://` passes the scheme refinement and fails only `.url()`, so
  // this case isolates the URL check — a value that failed both would stay green
  // if `.url()` were dropped.
  it("rejects a report URI that is https:// but not a parseable URL", () => {
    process.env.CSP_REPORT_URI = "https://";

    expect(() => keys()).toThrow("Invalid environment variables");
    expect(reportedIssues()).toContainEqual(
      expect.objectContaining({
        path: ["CSP_REPORT_URI"],
        message: "Invalid URL",
      })
    );
  });

  it("treats an empty string as unset rather than as a validation failure", () => {
    process.env.CSP_REPORT_URI = "";
    process.env.CSP_ENABLED = "";

    const parsed = keys();

    expect(parsed.CSP_REPORT_URI).toBeUndefined();
    expect(parsed.CSP_ENABLED).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(["true", "false"])(
    "accepts the literal CSP_ENABLED value %s",
    (value) => {
      process.env.CSP_ENABLED = value;

      expect(keys().CSP_ENABLED).toBe(value);
      expect(consoleError).not.toHaveBeenCalled();
    }
  );

  // `z.enum(["true","false"])` is the only thing standing between a typo and a
  // silently disabled CSP; anything truthy-looking has to be refused, not
  // coerced.
  it.each(["1", "yes", "TRUE", "0"])(
    "rejects the non-literal CSP_ENABLED value %s",
    (value) => {
      process.env.CSP_ENABLED = value;

      expect(() => keys()).toThrow("Invalid environment variables");
      expect(reportedIssues()).toContainEqual(
        expect.objectContaining({ path: ["CSP_ENABLED"] })
      );
    }
  );

  // Named so it is obvious this case proves nothing about the refinement:
  // `.optional()` sits after `.refine()`, so an absent value never reaches it.
  it("validates with both variables absent, which is why the http:// case above is the real assertion", () => {
    const parsed = keys();

    expect(parsed.CSP_REPORT_URI).toBeUndefined();
    expect(parsed.CSP_ENABLED).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it.each(["CSP_EXTRA_IMG_SRC", "CSP_EXTRA_CONNECT_SRC"] as const)(
    "parses %s into a trimmed https origin array",
    (name) => {
      process.env[name] =
        "https://example-file-attachments.s3.us-east-1.amazonaws.com, https://img.shields.io";

      expect(keys()[name]).toEqual([
        "https://example-file-attachments.s3.us-east-1.amazonaws.com",
        "https://img.shields.io",
      ]);
      expect(consoleError).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["an http:// entry", "http://bucket.s3.us-east-1.amazonaws.com"],
    [
      "an entry with a path",
      "https://bucket.s3.us-east-1.amazonaws.com/prefix",
    ],
    ["a trailing comma (empty entry)", "https://img.shields.io,"],
    ["a bare hostname", "img.shields.io"],
    ["a wildcard host-source", "https://*.s3.us-east-1.amazonaws.com"],
  ])("rejects CSP_EXTRA_IMG_SRC containing %s", (_label, value) => {
    process.env.CSP_EXTRA_IMG_SRC = value;

    expect(() => keys()).toThrow("Invalid environment variables");
    expect(reportedIssues()).toContainEqual(
      expect.objectContaining({
        path: ["CSP_EXTRA_IMG_SRC"],
        message:
          "CSP_EXTRA_IMG_SRC must be a comma-separated list of https:// origins with no path",
      })
    );
  });

  // The connect-src variable goes through the same factory; this pins that the
  // factory is actually applied to it (the issue path names the variable).
  it("rejects an http:// entry in CSP_EXTRA_CONNECT_SRC with its own variable name in the issue", () => {
    process.env.CSP_EXTRA_CONNECT_SRC =
      "http://bucket.s3.us-east-1.amazonaws.com";

    expect(() => keys()).toThrow("Invalid environment variables");
    expect(reportedIssues()).toContainEqual(
      expect.objectContaining({
        path: ["CSP_EXTRA_CONNECT_SRC"],
        message:
          "CSP_EXTRA_CONNECT_SRC must be a comma-separated list of https:// origins with no path",
      })
    );
  });

  it("treats an empty CSP extra source list as unset", () => {
    process.env.CSP_EXTRA_CONNECT_SRC = "";

    expect(keys().CSP_EXTRA_CONNECT_SRC).toBeUndefined();
    expect(consoleError).not.toHaveBeenCalled();
  });

  function reportedIssues(): { path: string[]; message: string }[] {
    const issues = consoleError.mock.calls
      .flat()
      .find((argument): argument is { path: string[]; message: string }[] =>
        Array.isArray(argument)
      );
    if (issues === undefined) {
      throw new Error(
        `expected t3-env to report validation issues, got: ${JSON.stringify(consoleError.mock.calls)}`
      );
    }
    return issues;
  }
});

// `SKIP_ENV_VALIDATION` is cleared alongside the two real variables: inherited
// from the shell or a CI lane it short-circuits `createEnv` entirely, and every
// rejection case below would stop exercising the schema.
const MANAGED_VARS = [
  "CSP_ENABLED",
  "CSP_REPORT_URI",
  "CSP_EXTRA_IMG_SRC",
  "CSP_EXTRA_CONNECT_SRC",
  "SKIP_ENV_VALIDATION",
] as const;
