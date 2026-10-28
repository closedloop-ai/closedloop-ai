// @vitest-environment jsdom
import {
  DIAGNOSTICS_BOTH_HOST_CONTRACT,
  type DiagnosticsHostFixture,
} from "@repo/app/diagnostics/__tests__/diagnostics-both-host-contract";
import {
  runBothHostContract,
  WEB_HOST,
} from "@repo/app/shared/testing/both-host-render-contract";
import { cleanup, render } from "@testing-library/react";
import { WebDiagnosticsSurfaceHost } from "../components/diagnostics-surface-host";

/**
 * ISS-10006 — the WEB half of the Diagnostics both-host contract, the runner
 * `packages/app/diagnostics/__tests__/diagnostics-both-host-contract.ts` was
 * written owing.
 *
 * It exists to make web's DIVERGENCE checkable rather than asserted. Three of
 * the four cases describe what a probe answered, and web has no probe — the read
 * is `getDiagnostics` over the gateway store on the machine that runs the
 * agents, which no browser can reach. The runner mounts this host against each
 * of those fixtures and FAILS if web renders the state after all, so the day web
 * gains a probe the stale divergence entries redden instead of excusing the
 * shell forever.
 *
 * The fixture is deliberately IGNORED here, and that is the finding: this host
 * answers the same way whatever a probe would have said, because nothing asks
 * one. Wiring the fixture into a fake `window.desktopApi` would manufacture a
 * capability production does not have and turn three real divergences green.
 */
runBothHostContract<DiagnosticsHostFixture>({
  contract: DIAGNOSTICS_BOTH_HOST_CONTRACT,
  host: WEB_HOST,
  mount: () => {
    cleanup();
    render(<WebDiagnosticsSurfaceHost />);
  },
});
