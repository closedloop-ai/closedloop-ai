import {
  CustomFieldEntityType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { readEntityCustomFieldValues } from "../../custom-fields/lib/read-entity-custom-field-values";

export type AgentSessionCustomFieldValuesRead = {
  /**
   * ISS-12302: one session's custom-field values, from
   * `GET /agent-sessions/[id]/custom-field-values`, for its Details tab.
   * Optional because desktop Local mode has no custom-field data; the Details
   * tab reads that absence as "draw no Custom fields section and read nothing".
   */
  customFieldValues?(id: string): Promise<readonly CustomFieldValueDetail[]>;
};

export function httpAgentSessionCustomFieldValuesRead(api: {
  get<T>(path: string): Promise<T>;
}): Required<AgentSessionCustomFieldValuesRead> {
  return {
    customFieldValues: (id) =>
      readEntityCustomFieldValues(api, CustomFieldEntityType.Session, id),
  };
}
