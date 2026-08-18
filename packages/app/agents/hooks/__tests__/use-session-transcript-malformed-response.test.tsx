/**
 * A sibling of `use-session-transcript.test.tsx` rather than an addition to it.
 *
 * That parent file sits on `biome.jsonc`'s `noExcessiveLinesPerFile` grandfather
 * list, which is SHRINK-ONLY: a grandfathered file must never grow, and the
 * required `check:grandfather-line-growth` gate rejects any commit that grows
 * one. Appending this case pushed it 1042 → 1088 logical lines, so it lives
 * here instead. The parent still owes a split by responsibility; that is
 * deliberately not attempted here.
 *
 * What this proves: `useTranscriptAccess` survives a descriptor response that
 * OMITS `files`, and its pending-poll resolver reports "nothing pending" on that
 * payload instead of throwing — i.e. the optional chain in
 * `hasPendingTranscript` is load-bearing.
 */

import type { TranscriptAccessResponse } from "@repo/api/src/types/desktop-transcripts";
import { useQueryClient } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import { agentSessionKeys } from "../use-agent-sessions";
import { useTranscriptAccess } from "../use-session-transcript";

const SESSION_ID = "session-1";

describe("useTranscriptAccess malformed access response", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Advance fake timers inside `act` so query refetches settle cleanly. */
  async function advance(ms: number) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  /**
   * Settle a freshly-mounted/refetched query under fake timers without
   * testing-library's `waitFor` (which schedules on real timers and would hang).
   * A few zero-tick advances flush the fixture-fetch promise + React commit.
   */
  async function settle() {
    for (let i = 0; i < 8; i += 1) {
      await advance(1);
    }
  }

  /**
   * WHY this payload is reachable: `transcriptAccessResponseSchema` declares
   * `files` as required, but it is never applied on this fetch path —
   * `api.get<T>()` only `JSON.parse`s the body and casts it — so the type's
   * guarantee is unenforced at runtime and a descriptor response that omits the
   * key lands in the cache as-is. Without the optional chain on `files` the
   * pending-poll resolver throws on it.
   */
  it("does not throw when the access response omits files", async () => {
    // `files` is OMITTED — not null, not `[]` — which is exactly the shape the
    // wire type wrongly promises cannot arrive.
    const filesOmitted = { sessionId: SESSION_ID } as TranscriptAccessResponse;
    let client: ReturnType<typeof useQueryClient> | undefined;
    function ClientProbe() {
      client = useQueryClient();
      return null;
    }
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AppCoreStoryProviders
        apiRoutes={[
          {
            method: "GET",
            path: `/agent-sessions/${SESSION_ID}/transcript`,
            respond: () => filesOmitted,
          },
        ]}
      >
        <ClientProbe />
        {children}
      </AppCoreStoryProviders>
    );
    const { result } = renderHook(() => useTranscriptAccess(SESSION_ID), {
      wrapper,
    });
    await settle();

    // The malformed payload settled instead of crashing the hook.
    expect(result.current.data).toEqual(filesOmitted);
    expect(result.current.isError).toBe(false);

    // And the pending determination resolves falsey on it, so React Query
    // schedules no poll. Executed against the real observer option — the exact
    // call site where an unguarded `data.files.some` would throw.
    const query = client
      ?.getQueryCache()
      .find({ queryKey: agentSessionKeys.transcriptAccess(SESSION_ID) });
    if (query === undefined) {
      throw new Error("the transcript-access query was never observed");
    }
    const resolveInterval = query.observers[0]?.options.refetchInterval;
    if (typeof resolveInterval !== "function") {
      throw new Error("refetchInterval is not the pending-poll resolver");
    }
    expect(resolveInterval(query)).toBe(false);
  });
});
