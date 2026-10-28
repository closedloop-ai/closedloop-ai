import { createHash } from "node:crypto";
import {
  type DesktopBootstrapLogoReference,
  type DesktopBootstrapOrganizationLogo,
  desktopBootstrapLogoUploadResultSchema,
  desktopBootstrapOrganizationLogoSchema,
} from "@repo/api/src/types/desktop-bootstrap";
import {
  type DesktopSessionResult,
  mapDesktopSessionErrorResponse,
} from "../session/desktop-session-client.js";

/** Only main handles the credential and presigned URL; bytes bypass the API. */
export async function uploadDesktopBootstrapLogo(input: {
  url: string;
  bootstrapToken: string;
  logo: DesktopBootstrapOrganizationLogo;
  fetchImpl: typeof fetch;
}): Promise<DesktopSessionResult<DesktopBootstrapLogoReference>> {
  const parsed = desktopBootstrapOrganizationLogoSchema.safeParse(input.logo);
  if (!parsed.success) {
    return { ok: false, error: "invalid", retryable: false };
  }
  const bytes = Buffer.from(parsed.data.base64, "base64");
  const reference = {
    name: parsed.data.name,
    type: parsed.data.type,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    const authorized = await input.fetchImpl(input.url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${input.bootstrapToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reference),
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await authorized.json().catch(() => null);
    if (!authorized.ok) {
      return {
        ok: false,
        ...mapDesktopSessionErrorResponse(authorized.status, body),
      };
    }
    const upload = desktopBootstrapLogoUploadResultSchema.safeParse(body);
    if (!upload.success) {
      return { ok: false, error: "invalid", retryable: false };
    }
    const uploaded = await input.fetchImpl(upload.data.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": reference.type,
        "Content-Length": String(reference.size),
      },
      body: bytes,
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (!uploaded.ok) {
      return { ok: false, error: "network", retryable: true };
    }
    return { ok: true, value: reference };
  } catch {
    return { ok: false, error: "network", retryable: true };
  }
}
