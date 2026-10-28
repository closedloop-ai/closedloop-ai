import { ArtifactType } from "@repo/api/src/types/artifact";
import {
  SESSION_STATUS,
  type SessionStatus,
} from "@repo/api/src/types/session-status";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import {
  getRowTypeConfig,
  resolveServedSessionDisplayStatus,
} from "@repo/app/documents/components/table/row-type-registry";
import { makeRawArtifact } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it } from "vitest";

/**
 * ISS-8694: the artifact tables on Projects and My Tasks used to render the
 * SERVER's derived session display status (Stale/Unknown), ahead of the row's
 * own stored status.
 *
 * ISS-10364 (operator ruling, 2026-09-23/24) made that enrichment PERMANENTLY
 * INERT: `resolveServedSessionDisplayStatus` always answers `undefined` now,
 * because its only two admissible outputs (`stale`, `unknown`) are retired
 * from the vocabulary. So `getRowTypeConfig`'s session branch always falls
 * through to the row's own stored status, regardless of the
 * `displayedSessionStatus` feature-flag gate and regardless of whatever a
 * legacy/version-skewed payload still carries in that field.
 *
 * The expectations are pinned to hand-written literals ("Failed", "failed")
 * rather than read back out of the label map the production path uses — a
 * test that re-derives its oracle from the code under test cannot fail when
 * that code is wrong.
 */

const STORED_STATUS = SESSION_STATUS.ACTIVE;

function sessionConfig(
  overrides: {
    status?: string;
    displayedSessionStatus?: string;
  },
  displayedSessionStatusEnabled: boolean
) {
  const { status = STORED_STATUS, displayedSessionStatus } = overrides;
  const item: DocumentRowItem = {
    kind: "session",
    data: makeRawArtifact(ArtifactType.Session, {
      id: "ses-1",
      status,
      // A wire value, so it is deliberately cast past the production
      // `SessionStatus` field type here: this field arrives as JSON from a
      // possibly-skewed API build and the type constrains nothing at runtime.
      // It is never read regardless.
      ...(displayedSessionStatus === undefined
        ? {}
        : { displayedSessionStatus: displayedSessionStatus as SessionStatus }),
    }),
  };
  // Composed exactly as `ArtifactNameCell` composes it, so the two exported
  // halves are exercised the way production pairs them.
  return displayedSessionStatusEnabled
    ? getRowTypeConfig(item, {
        sessionDisplayedStatus: resolveServedSessionDisplayStatus(item),
      })
    : getRowTypeConfig(item);
}

describe("getRowTypeConfig — the inert ISS-8694 enrichment (ISS-10364)", () => {
  it("ISS-10364: a legacy served `stale` payload no longer overrides the stored status", () => {
    const config = sessionConfig({ displayedSessionStatus: "stale" }, true);

    expect(config?.statusLabel).toBe("Active");
    expect(config?.statusIcon).toBe("in-progress");
    expect(config?.statusDescription).toBeUndefined();
  });

  it("ISS-10364: a legacy served `unknown` payload no longer overrides the stored status", () => {
    const unknown = sessionConfig({ displayedSessionStatus: "unknown" }, true);
    const active = sessionConfig(
      { displayedSessionStatus: SESSION_STATUS.ACTIVE },
      true
    );

    expect(unknown?.statusLabel).toBe(active?.statusLabel);
    expect(unknown?.statusIcon).toBe(active?.statusIcon);
    expect(unknown?.statusDescription).toBeUndefined();
  });

  it("falls back to the stored status when the field is ABSENT (old API build)", () => {
    // `error` rather than `active`: a fallback that silently rendered the
    // default would pass against an `active` fixture and prove nothing.
    const config = sessionConfig(
      { status: SESSION_STATUS.ERROR, displayedSessionStatus: undefined },
      true
    );

    expect(config?.statusLabel).toBe("Failed");
    expect(config?.statusIcon).toBe("failed");
    expect(config?.statusDescription).toBeUndefined();
  });

  it("falls back to the stored status when the field is UNRECOGNIZED (newer producer)", () => {
    const config = sessionConfig(
      {
        status: SESSION_STATUS.ERROR,
        displayedSessionStatus: "quiesced-awaiting-review",
      },
      true
    );

    expect(config?.statusLabel).toBe("Failed");
    expect(config?.statusIcon).toBe("failed");
    expect(config?.statusDescription).toBeUndefined();
  });

  it("ignores a prototype-polluting wire value rather than resolving an inherited key", () => {
    const config = sessionConfig(
      { status: SESSION_STATUS.ERROR, displayedSessionStatus: "constructor" },
      true
    );

    expect(config?.statusLabel).toBe("Failed");
  });

  it("renders today's raw-status mapping with the gate OFF, field present", () => {
    const config = sessionConfig(
      { status: STORED_STATUS, displayedSessionStatus: "stale" },
      false
    );

    expect(config?.statusLabel).toBe("Active");
    expect(config?.statusIcon).toBe("in-progress");
    expect(config?.statusDescription).toBeUndefined();
  });

  // ISS-10364: every served value is now refused, including a RECOGNIZED
  // lifecycle word — the field is never consulted at all, so the row's
  // grouping band, Status facet and `isRowItemCompleted` (which all read the
  // stored column) can never disagree with what this cell shows.
  it.each([
    {
      served: SESSION_STATUS.ACTIVE,
      stored: SESSION_STATUS.ERROR,
      label: "Failed",
      icon: "failed",
    },
    {
      served: SESSION_STATUS.INACTIVE,
      stored: SESSION_STATUS.ERROR,
      label: "Failed",
      icon: "failed",
    },
    {
      served: SESSION_STATUS.ERROR,
      stored: SESSION_STATUS.ACTIVE,
      label: "Active",
      icon: "in-progress",
    },
    {
      served: "waiting",
      stored: SESSION_STATUS.ERROR,
      label: "Failed",
      icon: "failed",
    },
  ])(
    "refuses a served $served — the field is never read any more",
    ({ served, stored, label, icon }) => {
      const config = sessionConfig(
        { status: stored, displayedSessionStatus: served },
        true
      );

      expect(config?.statusLabel).toBe(label);
      expect(config?.statusIcon).toBe(icon);
      expect(config?.statusDescription).toBeUndefined();
    }
  );

  it("never lets a legacy served word reach the row's own status field", () => {
    const item: DocumentRowItem = {
      kind: "session",
      data: makeRawArtifact(ArtifactType.Session, {
        id: "ses-1",
        status: STORED_STATUS,
        displayedSessionStatus: "stale" as SessionStatus,
      }),
    };

    expect(
      getRowTypeConfig(item, {
        sessionDisplayedStatus: resolveServedSessionDisplayStatus(item),
      })?.statusLabel
    ).toBe("Active");
    // The registry reads; it must not rewrite the artifact it was handed.
    expect(item.data.status).toBe(STORED_STATUS);
    expect(Object.values(SESSION_STATUS)).toContain(item.data.status);
  });
});
