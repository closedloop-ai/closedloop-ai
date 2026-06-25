import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

function readSource(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), "utf8");
}

// FEA-1497: PR #264 replaced the monolithic inline-JS index.html shell (which
// hosted the Diagnostics log viewer, the packaged update banner, and the
// security-settings copy) with a first-party React renderer. The update banner
// and API-key controls are now delivered as React components, so the previous
// string guards against index.html are superseded. These guards instead assert
// that the React components wire the real IPC channels/events. Behavior of the
// banner's visibility/apply gate is unit-tested in update-banner-state.test.ts.
describe("React renderer update banner wiring", () => {
  test("UpdateBanner subscribes to update events and gates apply on download", () => {
    const banner = readSource("src/renderer/components/UpdateBanner.tsx");

    assert.match(banner, /desktop:update-status/);
    assert.match(banner, /desktop:update-available/);
    assert.match(banner, /window\.desktopApi\.applyUpdate\(\)/);
    assert.match(banner, /isUpdateApplyEnabled/);
    assert.match(banner, /Relaunch to update/);
  });

  test("UpdateBanner is mounted in the app shell", () => {
    const app = readSource("src/renderer/App.tsx");

    assert.match(
      app,
      /import \{ UpdateBanner \} from "\.\/components\/UpdateBanner"/
    );
    assert.match(app, /<UpdateBanner\s*\/>/);
  });
});

describe("React renderer Security tab API-key controls", () => {
  test("SecurityTab wires set/clear/status IPC for the desktop API key", () => {
    const panel = readSource(
      "src/renderer/components/settings/SettingsPanel.tsx"
    );

    assert.match(panel, /window\.desktopApi\.getApiKeyStatus\(/);
    assert.match(panel, /window\.desktopApi\.setApiKey\(/);
    assert.match(panel, /window\.desktopApi\.clearApiKey\(/);
    // Set and Clear buttons must be present and refresh status after mutating.
    assert.match(panel, /onClick=\{handleSetApiKey\}/);
    assert.match(panel, /onClick=\{handleClearApiKey\}/);
    assert.match(panel, /refreshApiKeyStatus\(\)/);
  });
});

describe("React renderer Diagnostics log panel wiring", () => {
  test("LogsPanel is mounted via DiagnosticsView and wires the log IPC methods", () => {
    const app = readSource("src/renderer/App.tsx");
    const diagnosticsView = readSource(
      "src/renderer/components/diagnostics/diagnostics-view.tsx"
    );
    const panel = readSource(
      "src/renderer/components/diagnostics/LogsPanel.tsx"
    );

    assert.match(
      app,
      /import\("\.\/components\/diagnostics\/diagnostics-view"\)/
    );
    assert.match(app, /<DiagnosticsView\s/);
    assert.match(diagnosticsView, /<LogsPanel\s*\/>/);
    assert.equal(
      fs.existsSync("src/renderer/components/diagnostics/LogsPanel.tsx"),
      true
    );
    assert.match(panel, /window\.desktopApi\.getLogs\(\)/);
    assert.match(panel, /window\.desktopApi\.clearLogs\(\)/);
    assert.match(panel, /window\.desktopApi\s*\.\s*getLogFilePath\(\)/);
    assert.match(panel, /window\.desktopApi\.openLogFile\(\)/);
  });
});

// Still deferred beyond PR #264's settings slice: the security command-signing /
// browser-command-key management UI. These were covered by the old inline-JS
// index.html guards; re-guard them when the corresponding React work lands.
describe("deferred React renderer guards (command-signing UI)", {
  skip: "deferred beyond PR #264 settings slice; not yet implemented in React renderer",
}, () => {
  test("Security command-signing / browser-command-key UI copy (deferred)", () => {});
});
