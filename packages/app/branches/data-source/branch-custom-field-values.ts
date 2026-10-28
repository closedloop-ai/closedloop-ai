import {
  CustomFieldEntityType,
  type CustomFieldValueDetail,
} from "@repo/api/src/types/custom-field";
import { readEntityCustomFieldValues } from "../../custom-fields/lib/read-entity-custom-field-values";

export type BranchCustomFieldValuesRead = {
  /**
   * ISS-12302: one branch's custom-field values, from
   * `GET /branches/[id]/custom-field-values`, for its Details tab. Keyed by the
   * branch's `artifactId`, because the values service resolves `artifacts.id`
   * and a branch row's `id` may be an encoded repo/branch id. Optional because
   * desktop Local mode has no custom-field data; the Details tab reads that
   * absence as "draw no Custom fields section and read nothing".
   */
  customFieldValues?(
    artifactId: string
  ): Promise<readonly CustomFieldValueDetail[]>;
};

export function httpBranchCustomFieldValuesRead(api: {
  get<T>(path: string): Promise<T>;
}): Required<BranchCustomFieldValuesRead> {
  return {
    customFieldValues: (artifactId) =>
      readEntityCustomFieldValues(
        api,
        CustomFieldEntityType.Branch,
        artifactId
      ),
  };
}
