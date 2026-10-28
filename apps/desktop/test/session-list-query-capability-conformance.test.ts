/**
 * ISS-9476 — the desktop Sessions capability declaration in `@repo/api`
 * against the desktop read it describes. `packages/api` cannot import
 * `apps/desktop`, so the declaration is written out there and held to the
 * desktop code here: its sort half against `LocalSessionSortColumn`, and its
 * filter half against the keys the IPC query schema lets through.
 */
import { ListFieldValueFormat } from "@repo/api/src/types/list-query-capability";
import { listFieldLegacyParams } from "@repo/api/src/types/list-query-expression";
import { SessionListField } from "@repo/api/src/types/list-query-fields";
import { DESKTOP_SESSION_LIST_QUERY_CAPABILITY } from "@repo/api/src/types/session-list-query-capabilities";
import { SESSION_LIST_QUERY_FIELDS } from "@repo/api/src/types/session-list-query-registry";
import { describe, expect, it } from "vitest";
import { LocalSessionSortColumn } from "../src/main/session/session-sort-columns.js";
import { sanitizeQuery } from "../src/main/session/shared-agent-sessions-query.js";
import { SESSIONS_SURFACE_DATE_WINDOW_FIELD } from "../src/shared/session-date-window-contract.js";
import {
  sharedAgentSessionsQuerySchema,
  sharedAgentSessionsQueryShape,
} from "../src/shared/shared-agent-sessions-contract-schema.js";

const declaredFields = Object.entries(
  DESKTOP_SESSION_LIST_QUERY_CAPABILITY.fields
);

describe("desktop Sessions list query capability", () => {
  it("declares sortable exactly the columns the local read can order by", () => {
    const sortable = declaredFields
      .filter(([, served]) => served.sortable)
      .map(([field]) => field);
    expect(sortable.sort()).toEqual(
      Object.values(LocalSessionSortColumn).sort()
    );
  });

  it("declares filters only on params the IPC query schema lets through", () => {
    const acceptedKeys = new Set(Object.keys(sharedAgentSessionsQueryShape));
    for (const [field, served] of declaredFields) {
      if (served.operators.length === 0) {
        continue;
      }
      const spec = SESSION_LIST_QUERY_FIELDS[field as SessionListField];
      for (const param of listFieldLegacyParams(spec)) {
        expect(acceptedKeys.has(param), `${field} reads ${param}`).toBe(true);
      }
    }
  });

  it("declares a filter for every legacy facet the IPC schema lets through", () => {
    const acceptedKeys = new Set(Object.keys(sharedAgentSessionsQueryShape));
    for (const [field, spec] of Object.entries(SESSION_LIST_QUERY_FIELDS)) {
      const reachable = listFieldLegacyParams(spec).some((param) =>
        acceptedKeys.has(param)
      );
      if (!reachable) {
        continue;
      }
      const served = DESKTOP_SESSION_LIST_QUERY_CAPABILITY.fields[field];
      expect(
        served?.operators.length ?? 0,
        `${field} undeclared`
      ).toBeGreaterThan(0);
    }
  });

  it("leaves out the project facet, which the IPC schema strips", () => {
    const projectParam =
      SESSION_LIST_QUERY_FIELDS[SessionListField.ProjectIds].anyOf?.param;
    expect(projectParam).toBeDefined();
    expect(Object.keys(sharedAgentSessionsQueryShape)).not.toContain(
      projectParam
    );
    expect(
      Object.hasOwn(
        DESKTOP_SESSION_LIST_QUERY_CAPABILITY.fields,
        SessionListField.ProjectIds
      )
    ).toBe(false);
  });

  it("declares NonBlankString on exactly the facets whose read drops a number or a blank", () => {
    const acceptedKeys = new Set(Object.keys(sharedAgentSessionsQueryShape));
    const droppingFields: string[] = [];
    for (const [field, spec] of Object.entries(SESSION_LIST_QUERY_FIELDS)) {
      const param = spec.anyOf?.param;
      const served = DESKTOP_SESSION_LIST_QUERY_CAPABILITY.fields[field];
      if (!(param && acceptedKeys.has(param)) || served?.values) {
        continue;
      }
      const read: Record<string, unknown> = sanitizeQuery(
        sharedAgentSessionsQuerySchema.parse({ [param]: ["kept", 7, "  "] }),
        SESSIONS_SURFACE_DATE_WINDOW_FIELD
      );
      if (JSON.stringify(read[param]) === JSON.stringify(["kept"])) {
        droppingFields.push(field);
      }
    }
    const declared = declaredFields
      .filter(
        ([, served]) =>
          served.valueFormat === ListFieldValueFormat.NonBlankString
      )
      .map(([field]) => field);
    expect(droppingFields.length).toBeGreaterThan(0);
    expect(declared.sort()).toEqual(droppingFields.sort());
  });
});
