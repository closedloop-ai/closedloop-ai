import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCommandSigningCapabilities,
  shouldEnforceCommandSigning,
} from "../src/shared/command-signing-policy.js";

test("buildCommandSigningCapabilities omits commandSigningRequired by default", () => {
  assert.deepEqual(
    buildCommandSigningCapabilities({
      commandSigningEnforcementEnabled: false,
    }),
    {
      tools: {
        claude: false,
        codex: false,
        git: false,
        gh: false,
        python3: false,
      },
      versions: {},
      commandSigning: true,
    }
  );
});

test("buildCommandSigningCapabilities advertises commandSigningRequired only when opted in", () => {
  assert.deepEqual(
    buildCommandSigningCapabilities({
      commandSigningEnforcementEnabled: true,
    }),
    {
      tools: {
        claude: false,
        codex: false,
        git: false,
        gh: false,
        python3: false,
      },
      versions: {},
      commandSigning: true,
      commandSigningRequired: true,
    }
  );
});

test("shouldEnforceCommandSigning requires server support and local opt-in", () => {
  assert.equal(
    shouldEnforceCommandSigning({
      serverCommandSigningSupported: true,
      commandSigningEnforcementEnabled: true,
    }),
    true
  );
  assert.equal(
    shouldEnforceCommandSigning({
      serverCommandSigningSupported: false,
      commandSigningEnforcementEnabled: true,
    }),
    false
  );
  assert.equal(
    shouldEnforceCommandSigning({
      serverCommandSigningSupported: true,
      commandSigningEnforcementEnabled: false,
    }),
    false
  );
});
