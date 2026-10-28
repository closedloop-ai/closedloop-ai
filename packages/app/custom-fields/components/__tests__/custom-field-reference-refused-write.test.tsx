/**
 * ISS-9352 — a REFUSED reference write must not escape as an unhandled
 * rejection.
 *
 * #7791 review (whitlockk, tamsinb): this PR hands the host's mutation promise to
 * `CustomFieldTableCell` so a refused ENUM write can reach the shared cell's
 * commit ledger. The reference editor is on the same prop and does NOT use the
 * ledger, and it is reached with `gridview-adoption` CLOSED — so without a
 * consumer on its three call sites, this PR would turn a rejected
 * Reference/ReferenceMulti save into an unhandled rejection on the off path the
 * PR body calls unchanged.
 *
 * The listener is the assertion. Deleting `consumeReferenceWrite` from the
 * `choose` path makes Node report the rejection and reddens both cases, which
 * is the mutation this file exists to kill — the call site itself is otherwise
 * invisible to every other suite.
 */

import { ArtifactType } from "@repo/api/src/types/artifact";
import type {
  CustomFieldReferenceTarget,
  CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  CustomFieldEntityType,
  CustomFieldType,
  ReferenceTargetSource,
} from "@repo/api/src/types/custom-field";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { CustomFieldTableCell } from "../custom-field-table-cell";

afterEach(cleanup);

const ITEM_LABEL = "Row one";
const OWNER_ID = "entity-1";
const TARGET_NAME_RE = /A session/;

const TARGET: CustomFieldReferenceTarget = {
  artifactType: ArtifactType.Session,
  id: "target-1",
  name: "A session",
  slug: "sess-1",
  status: "active",
  subtype: null,
};

function referenceField(fieldType: CustomFieldType): CustomFieldWithOptions {
  return {
    createdAt: new Date("2026-08-25T12:00:00.000Z"),
    createdById: "user-1",
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    description: null,
    entityTypes: [CustomFieldEntityType.Session],
    enumOptions: [],
    fieldType,
    id: "field-links",
    isGlobalToOrg: false,
    isSearchable: false,
    isSortable: true,
    name: "Links",
    numberFormat: null,
    organizationId: "org-1",
    precision: null,
    referenceTargetSources: [ReferenceTargetSource.Session],
    showInTable: true,
    updatedAt: new Date("2026-08-25T12:00:00.000Z"),
  };
}

/** Node reports an unconsumed rejection here; a consumed one never arrives. */
async function unhandledRejectionsWhile(
  act: () => Promise<void>
): Promise<unknown[]> {
  const seen: unknown[] = [];
  const onUnhandled = (reason: unknown) => seen.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    await act();
    // Node raises `unhandledRejection` only once the microtask queue has
    // drained with no handler attached, so a macrotask turn is what makes the
    // absence below meaningful rather than merely early.
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  return seen;
}

describe.each([CustomFieldType.Reference, CustomFieldType.ReferenceMulti])(
  "%s cell, refused write",
  (fieldType) => {
    it("consumes the rejected write instead of leaving it unhandled", async () => {
      // NOT `vi.fn`: vitest records a spy's promise result and attaches its own
      // handler to settle `mock.settledResults`, which consumes the rejection
      // and makes the assertion below pass no matter what the cell does.
      let calls = 0;
      const onValueChange = () => {
        calls += 1;
        return Promise.reject(new Error("refused"));
      };

      render(
        <CustomFieldTableCell
          field={referenceField(fieldType)}
          itemLabel={ITEM_LABEL}
          onValueChange={onValueChange}
          ownerEntityId={OWNER_ID}
          referenceOptions={[TARGET]}
        />
      );

      const seen = await unhandledRejectionsWhile(async () => {
        await userEvent.click(
          screen.getByRole("button", { name: `Edit Links for ${ITEM_LABEL}` })
        );
        await userEvent.click(
          screen.getByRole("button", { name: TARGET_NAME_RE })
        );
      });

      // Presence first: without this the absence below passes on a cell that
      // never wrote at all.
      expect(calls).toBe(1);
      expect(seen).toEqual([]);
    });
  }
);
