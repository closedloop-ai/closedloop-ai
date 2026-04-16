export const MCP_INSTRUCTIONS = [
  "You have access to the ClosedLoop MCP server. Use its read-only tools to ground your answers:",
  "- get-document, list-document-versions, get-document-comments, get-related-documents, list-attachments, download-attachment",
  "- get-feature, list-features",
  "- get-workstream, list-workstreams",
  "- get-project, list-projects",
  "- list-entity-links, list-external-links",
  "- get-loop, list-loops",
  "- get-github-status, get-linear-status, get-google-status",
  "- get-me, get-dashboard-stats, list-users, list-templates, ping",
  "Prefer fetching content over guessing. Cite the document slug when referencing fetched content.",
].join("\n");
