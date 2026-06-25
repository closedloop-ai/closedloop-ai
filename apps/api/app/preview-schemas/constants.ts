const PREVIEW_SCHEMA_SOURCE_REPO_OWNER = "closedloop-ai";
const PREVIEW_SCHEMA_SOURCE_REPO_NAME = "symphony-alpha";

export const PreviewSchemaSourceRepo = {
  owner: PREVIEW_SCHEMA_SOURCE_REPO_OWNER,
  name: PREVIEW_SCHEMA_SOURCE_REPO_NAME,
  fullName: `${PREVIEW_SCHEMA_SOURCE_REPO_OWNER}/${PREVIEW_SCHEMA_SOURCE_REPO_NAME}`,
} as const;
