import {
  type CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import type { CustomFieldTableValue } from "../../components/custom-field-table-cell";
import { applyOptimisticCustomFieldValue } from "../optimistic-custom-field-value";
import {
  deferred,
  ENTITY_ID,
  makeField,
  makeOption,
  makeValue,
} from "./custom-field-details-fixtures";

/**
 * ISS-12302: the custom fields, values and fixture routes a Details host test
 * serves its real data source, kept apart from the save-trigger suite so a
 * suite without DOM matchers (desktop's renderer lane) can serve them too.
 */

export type RecordedRequest = { body: unknown; method: string; path: string };

export function customFieldDetailsFields(entityType: CustomFieldEntityType) {
  const entityTypes = [entityType];
  const risk = makeField("risk", CustomFieldType.Text, {
    entityTypes,
    name: "Risk",
  });
  const estimate = makeField("estimate", CustomFieldType.Number, {
    entityTypes,
    name: "Estimate",
  });
  const low = makeOption("severity", "low", "Low");
  const high = makeOption("severity", "high", "High");
  const severity = makeField("severity", CustomFieldType.Enum, {
    entityTypes,
    enumOptions: [low, high],
    name: "Severity",
  });
  const labels = makeField("labels", CustomFieldType.MultiEnum, {
    entityTypes,
    enumOptions: [
      makeOption("labels", "alpha", "Alpha"),
      makeOption("labels", "beta", "Beta"),
    ],
    name: "Labels",
  });
  const notes = makeField("notes", CustomFieldType.Text, {
    entityTypes,
    name: "Notes",
  });
  const definitions = [risk, estimate, severity, labels, notes];
  const values: CustomFieldValueDetail[] = [
    makeValue(risk, { textValue: "high" }),
    makeValue(estimate, { numberValue: 3 }),
    makeValue(severity, { enumValue: high }),
  ];
  return { definitions, labels, values };
}

/**
 * The org's definitions, the entity's values, and a PUT per field that the
 * next values read reflects, as the server's would. A field listed in `refuse`
 * answers 400 once `release` is called, so a test can see the optimistic value
 * before the refusal lands.
 */
export function customFieldDetailsRoutes({
  definitions,
  entityPath,
  refuse,
  values,
}: {
  definitions: readonly CustomFieldWithOptions[];
  entityPath: string;
  refuse?: CustomFieldWithOptions;
  values: readonly CustomFieldValueDetail[];
}) {
  const requests: RecordedRequest[] = [];
  const held = deferred<void>();
  let stored: readonly CustomFieldValueDetail[] = values;
  const record = (
    context: { body: unknown; method: string; pathname: string },
    data: unknown
  ) => {
    requests.push({
      body: context.body,
      method: context.method,
      path: context.pathname,
    });
    return data;
  };
  const routes: FixtureRoute[] = [
    {
      method: "GET",
      path: "/custom-fields",
      respond: (context) => record(context, definitions),
    },
    {
      method: "GET",
      path: `${entityPath}/custom-field-values`,
      respond: (context) => record(context, stored),
    },
    ...(refuse
      ? [
          {
            error: "Refused",
            method: "PUT",
            path: `${entityPath}/custom-field-values/${refuse.id}`,
            respond: async (context: {
              body: unknown;
              method: string;
              pathname: string;
            }) => {
              record(context, null);
              await held.promise;
              return null;
            },
            status: 400,
          },
        ]
      : []),
    {
      method: "PUT",
      path: `${entityPath}/custom-field-values/*`,
      respond: (context) => {
        stored = storeValue(stored, definitions, context);
        return record(context, { deleted: true });
      },
    },
  ];
  return {
    release: () => held.resolve(),
    requests,
    routes,
    writes: () => requests.filter((request) => request.method === "PUT"),
  };
}

function storeValue(
  stored: readonly CustomFieldValueDetail[],
  definitions: readonly CustomFieldWithOptions[],
  context: { body: unknown; pathname: string }
): readonly CustomFieldValueDetail[] {
  const field = definitions.find((definition) =>
    context.pathname.endsWith(`/${definition.id}`)
  );
  const { value } = context.body as { value: CustomFieldTableValue };
  if (!field) {
    return stored;
  }
  const others = stored.filter((entry) => entry.customFieldId !== field.id);
  if (typeof value === "number") {
    return [...others, makeValue(field, { numberValue: value })];
  }
  if (typeof value === "string" && field.fieldType === CustomFieldType.Text) {
    return [...others, makeValue(field, { textValue: value })];
  }
  return (
    applyOptimisticCustomFieldValue(stored, field, value, {
      entityId: ENTITY_ID,
      people: [],
      referenceTargets: [],
    }) ?? stored
  );
}
