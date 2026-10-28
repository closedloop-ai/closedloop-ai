import {
  test as baseTest,
  type ElectronApplication,
  type TestInfo,
} from "@playwright/test";
import { createTelemetryReceiptParser } from "./telemetry-clock-receipt-parser.js";

type ExitCapture = {
  closed: Promise<void>;
  result: ReturnType<typeof createTelemetryReceiptParser>["result"];
  dispose: () => void;
};
const captures = new WeakMap<TestInfo, ExitCapture>();

/** Attach native cleanup proof without replacing an earlier product failure. */
export const telemetryClockTest = baseTest.extend<{
  telemetryClockReceipt: undefined;
}>({
  telemetryClockReceipt: [
    async ({ browserName: _browserName }, use, testInfo) => {
      let useFailed = false,
        failure: unknown;
      try {
        await use(undefined);
      } catch (error) {
        useFailed = true;
        failure = error;
      }
      const capture = captures.get(testInfo);
      try {
        await capture?.closed;
        const result = capture?.result() ?? {
          valid: false,
          faults: ["missing-clocked-launch"],
          receipt: null,
        };
        await testInfo.attach("telemetry-clock-exit", {
          body: Buffer.from(JSON.stringify(result)),
          contentType: "application/json",
        });
        if (
          !useFailed &&
          testInfo.status === "passed" &&
          (!result.valid || result.faults.length)
        ) {
          failure = new Error(
            "Telemetry clock final owner, completion or native cancellation receipt failed."
          );
        }
      } catch (error) {
        if (!useFailed) {
          failure = error;
        }
      } finally {
        capture?.dispose();
        captures.delete(testInfo);
      }
      if (useFailed || failure !== undefined) {
        throw failure;
      }
    },
    { auto: true },
  ],
});

/** Observe only the selected child's bounded marker; no raw stderr is persisted. */
export function captureTelemetryClockExit(app: ElectronApplication): void {
  const testInfo = baseTest.info();
  if (captures.has(testInfo)) {
    throw new Error(
      "One clocked real launch is required per operating-mode case."
    );
  }
  const child = app.process(),
    stderr = child.stderr;
  if (!stderr) {
    throw new Error("Canonical Electron child stderr is unavailable.");
  }
  const parser = createTelemetryReceiptParser();
  stderr.on("data", parser.write);
  const closed = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      parser.fault("clocked-child-already-terminal");
      parser.finish();
      resolve();
      return;
    }
    child.once("close", () => {
      parser.finish();
      resolve();
    });
  });
  captures.set(testInfo, {
    closed,
    result: parser.result,
    dispose: () => stderr.off("data", parser.write),
  });
}
