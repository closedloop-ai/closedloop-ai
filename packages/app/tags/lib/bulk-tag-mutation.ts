export const BulkTagMutation = {
  Add: "add",
  Remove: "remove",
} as const;
export type BulkTagMutation =
  (typeof BulkTagMutation)[keyof typeof BulkTagMutation];
