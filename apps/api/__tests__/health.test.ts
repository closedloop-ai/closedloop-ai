import { describe, expect, it } from "vitest";
import { GET } from "@/app/health/route";

describe("Health Check", () => {
  it("returns 200 OK with text body", async () => {
    const response = GET();
    expect(response.status).toBe(200);

    const text = await response.text();
    expect(text).toBe("OK");
  });

  // GAP-001: symphony-alpha returns plain text, not JSON.
  // This block documents the contract the smoke suite validates.
  describe("compatibility contract", () => {
    it("Content-Type is not application/json", () => {
      const response = GET();
      const contentType = response.headers.get("content-type");
      expect(contentType).not.toContain("application/json");
    });
  });
});
