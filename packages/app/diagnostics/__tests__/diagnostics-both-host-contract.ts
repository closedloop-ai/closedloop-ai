import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BothHostRenderContract } from "../../shared/testing/both-host-render-contract";
import {
  DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_TEST_ID,
  DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID,
} from "../components/diagnostics-surface-v2";

/**
 * ISS-10004 — the states every shell that mounts Diagnostics owes its reader,
 * asserted against each shell's REAL mount from inside that shell's own suite.
 *
 * The per-shell jsdom suites already prove the surface renders when handed a
 * `DiagnosticsSource`. What they cannot prove is that the shell's ADAPTER
 * produces one: the probe, the cleaned failure message and the section list are
 * host code, and a host that stopped supplying any of them would leave the
 * surface's own suite green. This runs the same three fixtures through whatever
 * the shell actually mounts.
 *
 * ISS-10006 ADDED THE WEB RUNNER, and with it three divergence entries — the
 * "either a passing host or a divergence the runner can see" this docstring used
 * to owe. Web's divergence is not a gap in its adapter: the probe is one local
 * read over the gateway store on the machine that runs the agents, and a browser
 * cannot reach it. So the three states BELOW that describe what a probe answered
 * are states web can never be in, and each says so and is verified saying so —
 * the runner mounts web and fails the case if web renders it after all.
 *
 * The FOURTH case is the one both shells owe, and it is what keeps web from
 * being a host this contract only ever asserts to fail. Diagnostics still MEANS
 * the same route on both shells, and its always-on sections are the surface's,
 * not a host's.
 */

/** What one host's diagnostics probe answers with. */
export type DiagnosticsHostFixture =
  | { readonly kind: "payload"; readonly payload: unknown }
  | { readonly kind: "rejection"; readonly message: string };

const HEALTHY_REPO_NAME = "acme/contract-repo";

function healthyPayload(): Record<string, unknown> {
  return {
    backfill: {
      artifactLinks: { lastScannedAt: null, totalScanned: 1 },
      prBackfill: { lastScannedAt: null, totalScanned: 2 },
    },
    linkStats: [],
    linkTotals: { linkedArtifacts: 0, linkedSessions: 0, totalLinks: 0 },
    repos: [
      {
        defaultBranch: "main",
        gitDir: "/contract/.git",
        id: "contract-repo",
        lastSeenAt: "2026-09-11T00:00:00.000Z",
        remoteUrl: null,
        repoFullName: HEALTHY_REPO_NAME,
        worktreeCount: 1,
      },
    ],
  };
}

async function openSection(label: string): Promise<void> {
  await userEvent.click(await screen.findByRole("tab", { name: label }));
}

export const DIAGNOSTICS_BOTH_HOST_CONTRACT: BothHostRenderContract<DiagnosticsHostFixture> =
  {
    cases: [
      {
        fixture: { kind: "payload", payload: healthyPayload() },
        name: "the always-on sections are offered, in the surface's own order",
        renderProblem: async () => {
          const root = await screen.findByTestId(
            DIAGNOSTICS_SURFACE_V2_TEST_ID
          );
          const labels = within(root)
            .getAllByRole("tab")
            .map((tab) => (tab.textContent ?? "").trim());
          const alwaysOn = ["Repos", "Backfill", "Links"];
          const offered = labels.filter((label) => alwaysOn.includes(label));
          return offered.join(",") === alwaysOn.join(",")
            ? undefined
            : `the always-on tabs were ${offered.join(",") || "absent"}, not ${alwaysOn.join(",")}`;
        },
      },
      {
        divergence: {
          web: "the browser has no probe to settle: `getDiagnostics` is a local read over the gateway store on the machine that runs the agents, so no payload ever names a repo here.",
        },
        fixture: { kind: "payload", payload: healthyPayload() },
        name: "a settled probe renders the repo the payload named",
        renderProblem: async () => {
          const root = await screen.findByTestId(
            DIAGNOSTICS_SURFACE_V2_TEST_ID
          );
          return within(root).queryByText(HEALTHY_REPO_NAME) === null
            ? `the surface mounted but no row named ${HEALTHY_REPO_NAME}`
            : undefined;
        },
      },
      {
        divergence: {
          web: "a malformed SECTION presupposes a payload, and the browser receives none — the section says this host cannot serve it at all, which is a different fault with a different next step.",
        },
        fixture: {
          kind: "payload",
          // ISS-10004 AC2. `linkTotals` is the field the superseded body read
          // straight through (`linkTotals.totalLinks`), so a producer that could
          // not build it threw inside render and unwound the page.
          payload: { ...healthyPayload(), linkTotals: undefined },
        },
        name: "a malformed section degrades to its own notice with the rest intact",
        renderProblem: async () => {
          await openSection("Links");
          const notice = screen.queryByTestId(
            DIAGNOSTICS_SURFACE_V2_MALFORMED_TEST_ID
          );
          if (notice === null) {
            return "the Links section showed no malformed notice";
          }
          // "It did not crash" is not observable on its own — prove the shell is
          // still answering by making an intact section render afterwards.
          await openSection("Repos");
          return screen.queryByText(HEALTHY_REPO_NAME) === null
            ? "the Repos section stopped rendering after a malformed Links payload"
            : undefined;
        },
      },
      {
        divergence: {
          web: "there is no probe to fail, so the browser's notice says the reader is on the wrong machine rather than carrying a message from a read that never ran.",
        },
        fixture: { kind: "rejection", message: "diagnostics table missing" },
        name: "a failed probe reports the host's cleaned message, not a crash",
        renderProblem: async () => {
          const alert = await screen.findByTestId(
            DIAGNOSTICS_SURFACE_V2_UNAVAILABLE_TEST_ID
          );
          return alert.textContent?.includes("diagnostics table missing") ===
            true
            ? undefined
            : `the failure notice did not carry the probe's message: ${alert.textContent}`;
        },
      },
    ],
    surface: "DiagnosticsSurfaceV2",
  };
