import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { uploadToS3 } from "../s3-upload";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  fetchMock.mockReset();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

const file = new File(["data"], "upload.txt", { type: "text/plain" });

describe("uploadToS3", () => {
  it("PUTs the file to the presigned URL with only the content type header", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await uploadToS3("https://s3.example.com/signed", file, "text/plain");

    expect(fetchMock).toHaveBeenCalledWith("https://s3.example.com/signed", {
      method: "PUT",
      body: file,
      headers: { "Content-Type": "text/plain" },
    });
  });

  it("throws with status and statusText on a non-2xx response", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: "Forbidden",
    });

    await expect(
      uploadToS3("https://s3.example.com/signed", file, "text/plain")
    ).rejects.toThrow("S3 upload failed: 403 Forbidden");
  });
});
