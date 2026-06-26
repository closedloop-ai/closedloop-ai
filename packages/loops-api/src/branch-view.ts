export const PrCommentAuthorKind = {
  User: "user",
  Bot: "bot",
} as const;
export type PrCommentAuthorKind =
  (typeof PrCommentAuthorKind)[keyof typeof PrCommentAuthorKind];
