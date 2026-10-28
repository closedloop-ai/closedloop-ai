/**
 * ISS-10005 — the DESKTOP half of `HELP_BOTH_HOST_CONTRACT`, run against the
 * shell's real mount: both flag reads, the host adapter, the docs-help IPC over
 * `window.desktopApi`, and the surface they feed.
 *
 * The shared fixtures and expectations live in `@repo/app`; this file supplies
 * only what is desktop's — the gate mocks and the IPC stand-in.
 */
import {
  type DocsHelpHostFixture,
  HELP_BOTH_HOST_CONTRACT,
} from "@repo/app/help/__tests__/help-both-host-contract";
import {
  DESKTOP_HOST,
  runBothHostContract,
} from "@repo/app/shared/testing/both-host-render-contract";
import { render } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// The three gates this route is behind, forced ON. `docsHelp` and the Labs
// container are PRD-555's destination gate and predate this ticket; ISS-9218's
// bar on mocking a desktop Labs entry beside a shared key is about a second half
// of the SURFACE's gate, and there is none — `help-complete-surface` is the
// whole of that.
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) =>
    key === "help-complete-surface" || key === "docsHelp" || key === "labsNav",
}));

// No deep-link params: the contract's cases exercise the host's own default
// selection, which is what a reader opening #/help gets.
vi.mock("@repo/navigation/use-search-params-value", () => ({
  useSearchParamsValue: () => new URLSearchParams(),
}));

// react-markdown is not what this contract speaks for.
vi.mock(
  "@closedloop-ai/design-system/components/ui/primitives/markdown-content",
  () => ({
    MarkdownContent: ({ text }: { text: string }) => <div>{text}</div>,
  })
);

import { HelpView } from "../help-view";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

function installDocsHelp(fixture: DocsHelpHostFixture): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      docsHelp: {
        getPage: vi.fn(() =>
          fixture.pageRejects
            ? Promise.reject(new Error("docs-help getPage failed"))
            : Promise.resolve(fixture.page)
        ),
        nav: vi.fn(() => Promise.resolve({ groups: fixture.navGroups })),
        search: vi.fn(() =>
          fixture.searchRejects
            ? Promise.reject(new Error("docs-help search failed"))
            : Promise.resolve({ hits: [], query: "" })
        ),
        status: vi.fn(() =>
          Promise.resolve({
            available: fixture.available,
            docsSiteUrl: "https://closedloop.ai/docs",
            generatedAt: new Date(0).toISOString(),
            pageCount: 2,
            sourceCommit: "abc123",
          })
        ),
      },
    },
  });
}

runBothHostContract({
  contract: HELP_BOTH_HOST_CONTRACT,
  host: DESKTOP_HOST,
  mount: (fixture) => {
    installDocsHelp(fixture);
    render(<HelpView />);
  },
});
