// HTTP Basic Auth in front of the whole Storybook.
//
// Vercel's own Password Protection needs the Advanced Deployment Protection
// add-on, which this team does not have, and SSO protection would force every
// viewer onto the ClosedLoop Vercel team. This mirrors what the "ClosedLoop
// Demo" deployment already does: gate at the edge with one shared credential.
//
// This file is the ONLY source of the credential that guards
// storybook.preview.closedloop-stage.ai. It is copied verbatim into
// .vercel/output/functions/middleware.func/index.js by
// scripts/build-vercel-output.mjs. Changing the password here and redeploying
// is what rotates it; there is no environment variable to change, because a
// static Build Output deployment has no runtime env to read.
//
// Keep DESIGNER-GUIDE.md in step with these values.
const USERNAME = "closedloop";
const PASSWORD = "kickback-preview-2026";
const REALM = "ClosedLoop Storybook";

export default function middleware(request) {
  const header = request.headers.get("authorization") || "";

  if (header.startsWith("Basic ")) {
    let decoded = "";
    try {
      decoded = atob(header.slice(6));
    } catch {
      decoded = "";
    }
    // Split on the FIRST colon only: passwords may legitimately contain one.
    const separator = decoded.indexOf(":");
    const user = separator === -1 ? "" : decoded.slice(0, separator);
    const pass = separator === -1 ? "" : decoded.slice(separator + 1);

    if (user === USERNAME && pass === PASSWORD) {
      return;
    }
  }

  return new Response("Authentication required", {
    status: 401,
    headers: {
      "www-authenticate": `Basic realm="${REALM}"`,
      "content-type": "text/plain",
    },
  });
}
