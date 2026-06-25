const LOCAL_ABSOLUTE_PATH_PATTERN =
  /\/Users\/|\/home\/runner\/|\/github\/workspace\/|\/tmp\/|\/private\/tmp\/|\/var\/folders\/|[A-Za-z]:\\/;

const LOCAL_ABSOLUTE_PATH_POSITIVE_CONTROLS = [
  "/Users/dev/work/symphony-alpha/packages/telemetry-contract/src/span.ts",
  "/home/runner/work/symphony-alpha/packages/telemetry-contract/src/span.ts",
  "/github/workspace/packages/telemetry-contract/src/span.ts",
  "/tmp/telemetry-contract/build/span.ts",
  "/private/tmp/telemetry-contract/build/span.ts",
  "/var/folders/10/telemetry-contract/build/span.ts",
  "C:\\Users\\dev\\symphony-alpha\\packages\\telemetry-contract\\src\\span.ts",
] as const;

export function assertNoLocalAbsolutePath(path: string, source: string) {
  if (LOCAL_ABSOLUTE_PATH_PATTERN.test(source)) {
    throw new Error(`${path} contains a local absolute path`);
  }
}

export function assertLocalAbsolutePathPositiveControls() {
  for (const localPath of LOCAL_ABSOLUTE_PATH_POSITIVE_CONTROLS) {
    assertNoLocalAbsolutePathPositiveControl(localPath);
  }
}

function assertNoLocalAbsolutePathPositiveControl(localPath: string) {
  try {
    assertNoLocalAbsolutePath("positive-control.txt", localPath);
  } catch {
    return;
  }
  throw new Error(`Local absolute path positive control passed: ${localPath}`);
}
