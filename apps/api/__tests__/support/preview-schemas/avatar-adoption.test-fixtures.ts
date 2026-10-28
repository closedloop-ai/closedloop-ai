/** Avatar projections queried by adoption in each suite's quoted test schema. */
export function avatarAdoptionDdl(quotedSchema: string): string {
  return `
CREATE TABLE ${quotedSchema}."github_user_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "avatar_url" text,
  "updated_at" timestamptz NOT NULL
);
CREATE TABLE ${quotedSchema}."external_comment_authors" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "avatar_url" text,
  "updated_at" timestamptz NOT NULL
);
`;
}
