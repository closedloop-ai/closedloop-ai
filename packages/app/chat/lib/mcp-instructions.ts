export const MCP_INSTRUCTIONS = [
  "You have access to the Closedloop MCP server. Use its read-only tools to ground your answers:",
  "- get-document, list-documents, list-document-versions, get-document-comments, list-attachments, download-attachment",
  "- get-project, list-projects",
  "- list-artifact-links",
  "- get-loop, list-loops",
  "- get-github-status, get-linear-status, get-google-status",
  "- get-me, list-users, list-templates, ping",
  "Documents cover PRDs (PRD-*), implementation plans (PLN-*), and features (FEA-*). When a user references a record by its slug, pass that slug directly to the relevant get-* tool — no UUID lookup needed.",
  "Prefer fetching content over guessing. Cite the document slug when referencing fetched content.",
].join("\n");
