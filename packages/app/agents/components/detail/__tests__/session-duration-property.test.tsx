// FEA-4275 / ISS-5131: the Properties-pane "Duration" row. PLN-2169 M2 moved
// the derivation into `values/session-duration-value.tsx`, where
// `values/__tests__/session-duration-value.test.tsx` pins it (one measure, no
// decomposition, a running number that advances); this file proves only that
// the row mounts that value's figure and sentence through its real render path.
// The measured figure through the row is pinned by
// `session-detail-list-duration-parity.test.tsx`.

import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { DURATION_NO_START_REASON } from "@repo/app/agents/lib/session-detail-duration-window";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SessionDurationProperty,
  type SessionDurationPropertySession,
} from "../session-duration-property";

/** The Duration row's label column. */
const DURATION_LABEL = "Duration";
/** The em-dash the shared `GridEmptyValue` renders for an absent value. */
const EM_DASH = "—";

function renderRow(session: SessionDurationPropertySession) {
  return render(<SessionDurationProperty session={session} />);
}

describe("SessionDurationProperty mounts the shared Duration value (PLN-2169 M2)", () => {
  it("carries the value's reason in the row's accessible name when nothing measured a span", () => {
    // ISS-5575 (visual-QA HIGH): the dash needs a reason, in the row's
    // accessible name rather than hover-only copy. No start instant is the one
    // reason that needs no clock to resolve.
    renderRow({
      status: SESSION_STATUS.INACTIVE,
      startedAt: null,
      endedAt: null,
    });

    const row = screen.getByText(DURATION_LABEL).closest(".prd-prop");
    expect(row?.textContent).toContain(EM_DASH);
    expect(row?.querySelector("button .sr-only")?.textContent).toBe(
      `, ${DURATION_NO_START_REASON}`
    );
  });
});
