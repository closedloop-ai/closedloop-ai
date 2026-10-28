import { describe, expect, it } from "vitest";
import {
  desktopBootstrapLogoReferenceSchema,
  desktopBootstrapOrganizationHttpRequestSchema,
  desktopBootstrapOrganizationRequestSchema,
  ORGANIZATION_LOGO_MAX_SIZE_BYTES,
} from "../desktop-bootstrap";

const organization = { name: "Acme", slug: "acme" };
const logo = { name: "logo.png", type: "image/png", base64: "bG9nbw==" };

describe("bootstrap organization logo contract", () => {
  it("accepts small staged references but not caller-selected URLs, keys or inline bytes on HTTP", () => {
    const reference = {
      name: "logo.png",
      type: "image/png",
      size: ORGANIZATION_LOGO_MAX_SIZE_BYTES,
      sha256: "a".repeat(64),
    };
    expect(
      desktopBootstrapOrganizationHttpRequestSchema.parse({
        ...organization,
        logo: reference,
      }).logo
    ).toEqual(reference);
    expect(
      desktopBootstrapOrganizationHttpRequestSchema.safeParse({
        ...organization,
        logo,
      }).success
    ).toBe(false);
    for (const extra of [
      { url: "https://internal/secret" },
      { key: "other-user/logo" },
      { size: ORGANIZATION_LOGO_MAX_SIZE_BYTES + 1 },
      { size: 0 },
    ]) {
      expect(
        desktopBootstrapLogoReferenceSchema.safeParse({
          ...reference,
          ...extra,
        }).success
      ).toBe(false);
    }
  });
  it("preserves old requests without adding a null logo", () => {
    expect(
      desktopBootstrapOrganizationRequestSchema.parse(organization)
    ).toEqual(organization);
  });
  it("preserves an optional logo", () => {
    expect(
      desktopBootstrapOrganizationRequestSchema.parse({ ...organization, logo })
    ).toEqual({ ...organization, logo });
  });
  it.each([
    null,
    { ...logo, base64: "!" },
    { ...logo, base64: "" },
    { ...logo, type: "text/html" },
    {
      ...logo,
      base64: Buffer.alloc(ORGANIZATION_LOGO_MAX_SIZE_BYTES + 1).toString(
        "base64"
      ),
    },
  ])("rejects invalid or oversized logos", (invalidLogo) => {
    expect(
      desktopBootstrapOrganizationRequestSchema.safeParse({
        ...organization,
        logo: invalidLogo,
      }).success
    ).toBe(false);
  });
});
