/**
 * ISS-9567 — the DESKTOP half of the Sessions column-width axis.
 *
 * `packages/app`'s `use-sessions-view-state-column-widths.test.tsx` owns the
 * axis itself. What is desktop's own and provable nowhere else is the fact this
 * shell's adapter decides: the axis lands under the desktop's OWN storage key
 * (`sessions:desktop`, per-user).
 *
 * Deliberately the REAL hook against REAL `localStorage`, the way
 * `sessions-desktop-view-state-persistence.test.tsx` beside it works: a mocked
 * `useSessionsViewState` would assert the mock's shape, not the shell's.
 */

import { sessionsCustomFieldColumnId } from "@repo/app/agents/components/sessions/sessions-list-custom-fields";
import { useSessionsViewState } from "@repo/app/agents/hooks/use-sessions-view-state";
import { SessionSortDir } from "@repo/app/agents/lib/session-sort-group";
import { AuthAdapterProvider } from "@repo/app/shared/auth/provider";
import { createStaticAuthAdapter } from "@repo/app/shared/auth/static-auth-adapter";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

const DESKTOP_PERSIST_KEY = "sessions:desktop";
const PER_USER_KEY = `sessions:saved-view:${DESKTOP_PERSIST_KEY}:u:user-1`;
const RESIZED_COLUMN_ID = "cost";
const RESIZED_WIDTH_PX = 277;
/**
 * ISS-10356: a custom-field column id, which the record holds a WIDTH for —
 * built from a UUID, as `CustomField.id` is.
 */
const CUSTOM_FIELD_COLUMN_ID = sessionsCustomFieldColumnId(
  "0197f3c2-0000-7000-8000-000000000001"
);
const CUSTOM_FIELD_WIDTH_PX = 287;

afterEach(() => {
  localStorage.clear();
});

function mountDesktopViewState() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AuthAdapterProvider
      adapter={createStaticAuthAdapter({ isLoaded: true, userId: "user-1" })}
    >
      {children}
    </AuthAdapterProvider>
  );
  return renderHook(() => useSessionsViewState(DESKTOP_PERSIST_KEY), {
    wrapper,
  });
}

describe("Sessions column widths on the desktop shell (ISS-9567)", () => {
  it("writes a resize into the desktop's own per-user saved view", () => {
    const { result } = mountDesktopViewState();

    act(() => {
      result.current.setColumnWidth(RESIZED_COLUMN_ID, RESIZED_WIDTH_PX);
    });

    // The desktop key, not web's: the two shells share one hook and
    // deliberately NOT one record, so a layout dragged in the Electron
    // window does not move the browser's.
    const stored = JSON.parse(localStorage.getItem(PER_USER_KEY) ?? "{}");
    expect(stored.columnWidths).toEqual({
      [RESIZED_COLUMN_ID]: RESIZED_WIDTH_PX,
    });
    expect(
      localStorage.getItem("sessions:saved-view:sessions:web:u:user-1")
    ).toBeNull();
  });

  it("round-trips a custom-field width through the desktop's own record (ISS-10356)", () => {
    const first = mountDesktopViewState();
    act(() => {
      first.result.current.setColumnWidth(
        CUSTOM_FIELD_COLUMN_ID,
        CUSTOM_FIELD_WIDTH_PX
      );
    });
    first.unmount();

    // A fresh mount reads it back from the desktop key alone, so this is the
    // restore a relaunch of the Electron window performs.
    const { result } = mountDesktopViewState();

    expect(result.current.columnWidths).toEqual({
      [CUSTOM_FIELD_COLUMN_ID]: CUSTOM_FIELD_WIDTH_PX,
    });
  });

  it("restores a desktop record written before custom-field widths existed unchanged", () => {
    localStorage.setItem(
      PER_USER_KEY,
      JSON.stringify({
        columnWidths: { [RESIZED_COLUMN_ID]: RESIZED_WIDTH_PX },
        hiddenColumns: [],
        sortDir: SessionSortDir.Desc,
        sortKey: null,
      })
    );

    const { result } = mountDesktopViewState();

    expect(result.current.columnWidths).toEqual({
      [RESIZED_COLUMN_ID]: RESIZED_WIDTH_PX,
    });
  });
});
