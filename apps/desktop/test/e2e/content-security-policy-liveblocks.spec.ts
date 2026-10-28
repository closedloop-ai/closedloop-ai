import { expect, test } from "@playwright/test";
import { launchDesktopApp } from "./helpers/desktop-app";

test("packaged renderer admits collaboration connections and blocks unrelated hosts", async () => {
  const { page, cleanup } = await launchDesktopApp({
    userDataPrefix: "desktop-csp-collaboration-",
  });
  try {
    const violations = await page.evaluate(async () => {
      const blocked: string[] = [];
      let resolveControl: () => void = () => {};
      const control = new Promise<void>((resolve) => {
        resolveControl = resolve;
      });
      const listener = (event: SecurityPolicyViolationEvent) => {
        if (event.effectiveDirective === "connect-src") {
          blocked.push(event.blockedURI);
          if (event.blockedURI.includes("collaboration-control.invalid")) {
            resolveControl();
          }
        }
      };
      document.addEventListener("securitypolicyviolation", listener);
      fetch("https://api.liveblocks.io/csp-probe").catch(() => {});
      const socket = new WebSocket("wss://api.liveblocks.io/csp-probe");
      fetch("https://collaboration-control.invalid/probe").catch(() => {});
      await Promise.race([
        control,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("CSP control was not enforced")),
            15_000
          )
        ),
      ]);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      socket.close();
      document.removeEventListener("securitypolicyviolation", listener);
      return blocked;
    });
    expect(
      violations.some((url) =>
        url.startsWith("https://collaboration-control.invalid")
      )
    ).toBe(true);
    expect(violations.some((url) => url.includes("api.liveblocks.io"))).toBe(
      false
    );
  } finally {
    await cleanup();
  }
});
