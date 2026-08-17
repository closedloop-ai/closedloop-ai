import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  classifyMacSigningEnv,
  MacSigningMode,
  macSigningFailureMessage,
  REQUIRED_MAC_SIGNING_ENV_VARS,
} from "../scripts/run-electron-builder-lib.mjs";
import {
  accessedProperties,
  calledIdentifiers,
  declaredFunctionNames,
  namedImportsFrom,
  parseDesktopScript,
} from "./helpers/entrypoint-wiring.js";

const LIB_MODULE = "./run-electron-builder-lib.mjs";
const ENTRYPOINT = "run-electron-builder.mjs";

const SIGNING_VAR_VALUES: Record<string, string> = {
  CSC_LINK: "base64-certificate",
  CSC_KEY_PASSWORD: "hunter2",
  APPLE_ID: "release@closedloop.ai",
  APPLE_APP_SPECIFIC_PASSWORD: "abcd-efgh-ijkl-mnop",
  APPLE_TEAM_ID: "TEAM123456",
};

function envWith(names: readonly string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of names) {
    env[name] = SIGNING_VAR_VALUES[name];
  }
  return env;
}

/** Every subset of the five required vars, as configured-name lists. */
function everyConfiguredSubset(): string[][] {
  let subsets: string[][] = [[]];
  for (const name of REQUIRED_MAC_SIGNING_ENV_VARS) {
    subsets = subsets.flatMap((subset) => [subset, [...subset, name]]);
  }
  return subsets;
}

describe("ISS-5303: run-electron-builder classifies the Apple signing secrets", () => {
  test("all five present and non-empty is the release signing path", () => {
    const classification = classifyMacSigningEnv(
      envWith(REQUIRED_MAC_SIGNING_ENV_VARS)
    );

    assert.equal(classification.mode, MacSigningMode.Signed);
    assert.deepEqual(classification.emptyDefined, []);
    assert.deepEqual(classification.absent, []);
    assert.deepEqual(classification.configured, [
      ...REQUIRED_MAC_SIGNING_ENV_VARS,
    ]);
  });

  test("none of the five defined is the local ad-hoc build path", () => {
    // Unset is NOT an error: electron-builder ad-hoc-signs and skips
    // notarization by design, and requiring signing here would make a local
    // `pnpm package` impossible.
    const classification = classifyMacSigningEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
    });

    assert.equal(classification.mode, MacSigningMode.Unsigned);
    assert.deepEqual(classification.emptyDefined, []);
    assert.deepEqual(classification.absent, [...REQUIRED_MAC_SIGNING_ENV_VARS]);
  });

  test("ignores env vars that are not part of the signing contract", () => {
    const classification = classifyMacSigningEnv({
      ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
      NOTARIZE: "",
      CSC_IDENTITY_AUTO_DISCOVERY: "",
    });

    assert.equal(classification.mode, MacSigningMode.Signed);
    assert.deepEqual(classification.emptyDefined, []);
  });
});

describe("ISS-5303: a partially configured environment is never signable", () => {
  for (const missing of REQUIRED_MAC_SIGNING_ENV_VARS) {
    test(`${missing} entirely absent, the other four set`, () => {
      const classification = classifyMacSigningEnv(
        envWith(REQUIRED_MAC_SIGNING_ENV_VARS.filter((n) => n !== missing))
      );

      assert.notEqual(classification.mode, MacSigningMode.Signed);
      assert.equal(classification.mode, MacSigningMode.Partial);
      assert.deepEqual(classification.absent, [missing]);
      assert.deepEqual(classification.emptyDefined, []);
    });

    test(`${missing} defined but empty, the other four set`, () => {
      // The CI failure this guard exists for: a referenced-but-unshared org
      // secret expands to "". Signing/notarization then half-happens and CI
      // reports green on a DMG Gatekeeper blocks.
      const classification = classifyMacSigningEnv({
        ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
        [missing]: "",
      });

      assert.notEqual(classification.mode, MacSigningMode.Signed);
      assert.equal(classification.mode, MacSigningMode.Misconfigured);
      assert.deepEqual(classification.emptyDefined, [missing]);
    });

    test(`${missing} defined as whitespace, the other four set`, () => {
      const classification = classifyMacSigningEnv({
        ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
        [missing]: "  \n\t ",
      });

      assert.equal(classification.mode, MacSigningMode.Misconfigured);
      assert.deepEqual(classification.emptyDefined, [missing]);
    });
  }

  test("a key present with an undefined value counts as defined-but-empty", () => {
    const classification = classifyMacSigningEnv({
      ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
      APPLE_TEAM_ID: undefined,
    });

    assert.equal(classification.mode, MacSigningMode.Misconfigured);
    assert.deepEqual(classification.emptyDefined, ["APPLE_TEAM_ID"]);
  });

  test("an empty-defined var outranks absent siblings", () => {
    // Fail-closed ordering: "one secret is blank" is a wiring bug regardless of
    // how many of the rest are simply not set, so it must not read as the
    // benign local `unsigned` path.
    const classification = classifyMacSigningEnv({ CSC_LINK: "" });

    assert.equal(classification.mode, MacSigningMode.Misconfigured);
    assert.deepEqual(classification.emptyDefined, ["CSC_LINK"]);
    assert.equal(classification.absent.length, 4);
  });

  test("`signed` is reachable ONLY from a fully configured environment", () => {
    // Exhaustive over all 32 subsets: this is the fail-closed direction stated
    // as a property rather than as a handful of examples. Widening the
    // classifier to accept any proper subset goes red here.
    let signedSubsets = 0;

    for (const configured of everyConfiguredSubset()) {
      const { mode } = classifyMacSigningEnv(envWith(configured));
      const isComplete =
        configured.length === REQUIRED_MAC_SIGNING_ENV_VARS.length;

      assert.equal(
        mode === MacSigningMode.Signed,
        isComplete,
        `configured=[${configured.join(",")}] classified as ${mode}`
      );
      if (mode === MacSigningMode.Signed) {
        signedSubsets += 1;
      }
    }

    assert.equal(signedSubsets, 1);
  });

  test("does not mutate the environment it classifies", () => {
    const env = envWith(REQUIRED_MAC_SIGNING_ENV_VARS);
    const before = { ...env };

    classifyMacSigningEnv(env);

    assert.deepEqual(env, before);
  });
});

describe("ISS-5303: the refusal message", () => {
  test("names every offending var and both remedies", () => {
    const message = macSigningFailureMessage(["CSC_LINK", "APPLE_TEAM_ID"]);

    assert.ok(message.startsWith("macOS signing/notarization env var(s)"));
    assert.ok(message.includes("CSC_LINK, APPLE_TEAM_ID"));
    // CI's remedy is the org-secret share; a developer's remedy is to UNSET.
    assert.ok(message.includes("org secrets"));
    assert.ok(message.includes("unset CSC_LINK/CSC_KEY_PASSWORD entirely"));
  });

  test("carries the exact vars the classifier reported", () => {
    const { emptyDefined } = classifyMacSigningEnv({
      ...envWith(REQUIRED_MAC_SIGNING_ENV_VARS),
      APPLE_ID: "",
      APPLE_APP_SPECIFIC_PASSWORD: "",
    });

    assert.ok(
      macSigningFailureMessage(emptyDefined).includes(
        "APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD"
      )
    );
  });
});

describe("ISS-5303: the required-secret set is the contract", () => {
  test("is exactly the five vars the release workflow sets together", () => {
    // Signing and notarization are one unit. Dropping a name here would let a
    // signed-but-un-notarized build class as `signed`.
    assert.deepEqual(
      [...REQUIRED_MAC_SIGNING_ENV_VARS],
      [
        "CSC_LINK",
        "CSC_KEY_PASSWORD",
        "APPLE_ID",
        "APPLE_APP_SPECIFIC_PASSWORD",
        "APPLE_TEAM_ID",
      ]
    );
  });
});

describe("ISS-5303: run-electron-builder.mjs is wired to the lib", () => {
  test("imports exactly the three symbols the lib exports for it", () => {
    // The entrypoint spawns a full electron-builder packaging run at module
    // scope, so nothing above this line executes it. Without this assertion,
    // re-inlining `classifyMacSigningEnv` back into the shell leaves all 32
    // subset cases green while packaging runs a SECOND, untested copy of the
    // fail-closed refusal.
    const entrypoint = parseDesktopScript(ENTRYPOINT);

    assert.deepEqual(namedImportsFrom(entrypoint, LIB_MODULE), [
      "MacSigningMode",
      "classifyMacSigningEnv",
      "macSigningFailureMessage",
    ]);
  });

  test("the imported names are the ones the lib actually exports", () => {
    // Not a tautology: it is the join between the two halves. The assertion
    // above reads the entrypoint's source, this one reads the loaded module, so
    // an import of a name the lib no longer exports fails here rather than at
    // `pnpm package` time.
    const imported = namedImportsFrom(
      parseDesktopScript(ENTRYPOINT),
      LIB_MODULE
    );
    const exported: Record<string, unknown> = {
      MacSigningMode,
      classifyMacSigningEnv,
      macSigningFailureMessage,
    };

    for (const name of imported) {
      assert.notEqual(
        exported[name],
        undefined,
        `${ENTRYPOINT} imports ${name}, which the lib does not export`
      );
    }
  });

  test("keeps no local copy of the classification", () => {
    const declared = declaredFunctionNames(parseDesktopScript(ENTRYPOINT));

    assert.deepEqual(
      declared.filter(
        (name) =>
          name === "classifyMacSigningEnv" ||
          name === "macSigningFailureMessage"
      ),
      []
    );
  });

  test("still classifies the env and still renders the refusal", () => {
    // Import without call is the other half of the revert: an entrypoint that
    // imports the classifier and then branches on a hand-rolled `if
    // (process.env.CSC_LINK === "")` would satisfy the import assertion alone.
    const called = calledIdentifiers(parseDesktopScript(ENTRYPOINT));

    assert.equal(called.includes("classifyMacSigningEnv"), true);
    assert.equal(called.includes("macSigningFailureMessage"), true);
  });

  test("refuses on Misconfigured and on nothing else", () => {
    // Which member the shell compares against IS the fail-closed policy.
    // Branching on `Partial` instead would keep every assertion above green
    // while letting an empty-defined CSC_LINK through to electron-builder.
    // A source-level MEMBER NAME, so the literal is the contract here — there
    // is no runtime constant whose value is the key `"Misconfigured"`. The
    // lookup below is what ties it back to the exported const object.
    const memberName = "Misconfigured";
    assert.equal(MacSigningMode[memberName], MacSigningMode.Misconfigured);
    assert.deepEqual(
      accessedProperties(parseDesktopScript(ENTRYPOINT), "MacSigningMode"),
      [memberName]
    );
  });
});
