import { ORGANIZATION_LOGO_MAX_SIZE_BYTES } from "@repo/api/src/types/desktop-bootstrap";
import { describe, expect, it, vi } from "vitest";
import { createDesktopBootstrapOrganization } from "../src/main/auth/desktop-bootstrap-client.js";

const organization = { name: "Acme", slug: "acme" };
const input = {
  apiOrigin: "https://api.example.com",
  bootstrapToken: "private-token",
  organization,
};
const tokens = {
  accessToken: "access",
  accessTokenExpiresAt: "2030-01-01T00:00:00Z",
  refreshToken: "refresh",
  refreshTokenExpiresAt: "2030-01-01T00:00:00Z",
  userId: "user-1",
  organizationId: "org-1",
};
const uploadUrl = "https://bucket.s3.amazonaws.com/staged?signature=value";

describe("Desktop bootstrap staged upload", () => {
  it("sends a 10MB logo directly to S3 and only small metadata bodies to the API", async () => {
    const bytes = Buffer.alloc(ORGANIZATION_LOGO_MAX_SIZE_BYTES, 1);
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ uploadUrl }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(Response.json(tokens));
    const result = await createDesktopBootstrapOrganization({
      ...input,
      organization: {
        ...organization,
        logo: {
          name: "logo.png",
          type: "image/png",
          base64: bytes.toString("base64"),
        },
      },
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const [authorize, upload, create] = fetchImpl.mock.calls;
    expect(authorize[1]?.method).toBe("PUT");
    expect(String(authorize[1]?.body).length).toBeLessThan(1024);
    expect(upload[0]).toBe(uploadUrl);
    // A deep toEqual over two 10 MiB Buffers exhausts the ~2 GB V8 heap on macOS runners (ISS-12249).
    const uploadedBody = upload[1]?.body;
    expect(Buffer.isBuffer(uploadedBody)).toBe(true);
    expect(Buffer.compare(uploadedBody as Buffer, bytes)).toBe(0);
    expect(upload[1]?.headers).not.toHaveProperty("Authorization");
    expect(upload[1]?.redirect).toBe("error");
    expect(create[1]?.method).toBe("POST");
    expect(String(create[1]?.body).length).toBeLessThan(1024);
    expect(JSON.parse(String(create[1]?.body)).logo).toEqual(
      JSON.parse(String(authorize[1]?.body))
    );
  });

  it("keeps the old no-logo flow to a single request with logo omitted", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(tokens));
    await createDesktopBootstrapOrganization({ ...input, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchImpl.mock.calls[0][1]?.body))).toEqual(
      organization
    );
  });

  it("does not create the organization when upload fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ uploadUrl }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect(
      await createDesktopBootstrapOrganization({
        ...input,
        organization: {
          ...organization,
          logo: { name: "logo.png", type: "image/png", base64: "bG9nbw==" },
        },
        fetchImpl,
      })
    ).toEqual({ ok: false, error: "network", retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not upload or create when the server rejects bootstrap authorization", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 401 }));
    const result = await createDesktopBootstrapOrganization({
      ...input,
      organization: {
        ...organization,
        logo: { name: "logo.png", type: "image/png", base64: "bG9nbw==" },
      },
      fetchImpl,
    });
    expect(result.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
