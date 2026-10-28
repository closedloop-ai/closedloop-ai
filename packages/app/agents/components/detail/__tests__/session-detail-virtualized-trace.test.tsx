import { AgentComponentInvocationAnchorKind } from "@repo/api/src/types/agent-component-invocation";
import type {
  AgentSessionDetail,
  TurnItem,
} from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TRACE_FLASH_CLASS } from "../../../lib/trace-scroll-target";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { AgentSessionDetailView } from "../agent-session-detail-view";
import {
  makeDbPromptRow,
  makeDbSayRow,
} from "./session-timeline-scroll-harness";

/**
 * ISS-12276 (PRD-792): Session detail windows its trace, as Branch detail does,
 * so a long session no longer builds every turn into the DOM. Operator ruling
 * (Marisol Ashgrove, 2026-10-08): web find-in-page then only finds turns near the
 * viewport. A deep link to a turn outside the mounted window must still reach
 * and mark it.
 */

const SESSION_ID = "session-virtualized-trace";
const TURN_COUNT = 2000;
const TARGET_ROW = 1500;
const START_MS = Date.parse("2026-07-09T11:00:00.000Z");
/** Well under the 2,000 turns; the window is the viewport plus overscan. */
const MAX_MOUNTED_ANCHORS = 100;

/**
 * Alternate prompts and replies so every turn renders as its own group (two
 * consecutive turns on one side would coalesce into one anchor).
 */
function turnItems(): TurnItem[] {
  return Array.from({ length: TURN_COUNT }, (_, row) => {
    const t = new Date(START_MS + row * 1000).toISOString();
    const text = `turn ${row}`;
    if (row % 2 === 0) {
      return {
        ...makeDbPromptRow({ row, sessionId: SESSION_ID, t, text }),
        transcriptIdentity: { userTurnId: `user-turn-${row}` },
      };
    }
    return makeDbSayRow({ row, sessionId: SESSION_ID, t, text });
  });
}

function longSession(): AgentSessionDetail {
  return createAgentSessionDetailFixture({
    id: SESSION_ID,
    harness: "claude",
    startedAt: new Date(START_MS),
    endedAt: new Date(START_MS + TURN_COUNT * 1000),
    transcripts: undefined,
    turnItems: turnItems(),
  });
}

/**
 * jsdom has no layout: it stores `scrollTop` but never fires `scroll` (a browser
 * does, before the next frame), and reports `scrollHeight` 0, which clamps
 * every scroll target to the top. Emulate both for the scroller.
 */
const LAID_OUT_SCROLL_HEIGHT_PX = 10_000_000;
let restoreScrollTop: (() => void) | null = null;

beforeEach(() => {
  const proto = HTMLElement.prototype;
  const positions = new WeakMap<HTMLElement, number>();
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return positions.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      positions.set(this, value);
      setTimeout(() => this.dispatchEvent(new Event("scroll")), 0);
    },
  });
  // The virtualizer's `scrollToIndex` (ISS-12276 reveal) scrolls through
  // `scrollTo`, which jsdom leaves unimplemented on elements.
  Object.defineProperty(proto, "scrollTo", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollToOptions) {
      if (typeof options?.top === "number") {
        this.scrollTop = options.top;
      }
    },
  });
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get: () => LAID_OUT_SCROLL_HEIGHT_PX,
  });
  // The shadows live on `HTMLElement.prototype`; deleting them re-exposes
  // jsdom's own `Element.prototype` accessors.
  restoreScrollTop = () => {
    Reflect.deleteProperty(proto, "scrollTop");
    Reflect.deleteProperty(proto, "scrollHeight");
    Reflect.deleteProperty(proto, "scrollTo");
  };
});

afterEach(() => {
  restoreScrollTop?.();
  restoreScrollTop = null;
});

describe("Session detail virtualized trace (ISS-12276)", () => {
  it("mounts a bounded number of turn rows for a 2,000-turn session", async () => {
    render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          isLoading={false}
          session={longSession()}
        />
      </AppCoreStoryProviders>
    );

    await screen.findByText("turn 0");
    const anchors = document.querySelectorAll(".st [data-row]");
    expect(anchors.length).toBeGreaterThan(0);
    expect(anchors.length).toBeLessThan(MAX_MOUNTED_ANCHORS);
    expect(screen.queryByText(`turn ${TURN_COUNT - 1}`)).toBeNull();
  });

  it("scrolls a deep link to a turn outside the mounted window and marks it", async () => {
    render(
      <AppCoreStoryProviders>
        <AgentSessionDetailView
          backHref="/sessions"
          invocationAnchor={{
            kind: AgentComponentInvocationAnchorKind.UserTurn,
            userTurnId: `user-turn-${TARGET_ROW}`,
          }}
          isLoading={false}
          session={longSession()}
        />
      </AppCoreStoryProviders>
    );

    await waitFor(
      () => {
        const flashed = document.querySelector(`.${TRACE_FLASH_CLASS}`);
        expect(flashed?.closest("[data-row]")).toHaveAttribute(
          "data-row",
          String(TARGET_ROW)
        );
      },
      { timeout: 10_000 }
    );
    const scroller = document.querySelector<HTMLElement>(".sd3-scroll");
    expect(scroller?.scrollTop).toBeGreaterThan(0);
  });
});
