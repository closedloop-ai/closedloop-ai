import { describe, expect, it, vi } from "vitest";
import {
  openDocumentAssetDownload,
  rewriteDocumentAssetResponse,
  serveDocumentAsset,
} from "../src/main/ipc/document-asset-proxy.js";

const storageUrl =
  "https://bucket.s3.us-east-1.amazonaws.com/file?signature=signed";

function mint(key: string, isCurrent = () => true, fields = {}) {
  const result = JSON.parse(
    rewriteDocumentAssetResponse(
      "/documents/doc-1/attachments/file-1",
      JSON.stringify({ data: { [key]: storageUrl, ...fields } }),
      isCurrent
    )
  );
  return result.data[key] as string;
}

describe("native document attachment capabilities", () => {
  it("uploads through main without renderer credentials or redirects", async () => {
    const url = mint("uploadUrl");
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const response = await serveDocumentAsset(
      new Request(url, {
        method: "PUT",
        body: "bytes",
        headers: {
          "Content-Type": "text/plain",
          Authorization: "renderer-token",
          Cookie: "cookie",
        },
      }),
      {},
      fetchImpl
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledWith(
      storageUrl,
      expect.objectContaining({
        method: "PUT",
        credentials: "omit",
        redirect: "error",
      })
    );
    const init = fetchImpl.mock.calls[0][1];
    expect([...init.headers.entries()]).toEqual([
      ["content-type", "text/plain"],
    ]);
    expect(new TextDecoder().decode(init.body)).toBe("bytes");
  });

  it("preserves a download filename and admits only minted downloads", async () => {
    const url = mint("downloadUrl");
    const download = vi.fn();
    expect(openDocumentAssetDownload(url, download)).toBe(true);
    expect(download).toHaveBeenCalledWith(url);
    expect(openDocumentAssetDownload(storageUrl, download)).toBe(false);
    expect(openDocumentAssetDownload("malformed", download)).toBe(false);
    expect(openDocumentAssetDownload(mint("uploadUrl"), download)).toBe(false);
    const disposition = 'attachment; filename="report.png"';
    const response = await serveDocumentAsset(
      new Request(url),
      {},
      vi.fn().mockResolvedValue(
        new Response("image", {
          headers: {
            "Content-Type": "image/png",
            "Content-Disposition": disposition,
          },
        })
      )
    );
    expect(response.headers.get("Content-Disposition")).toBe(disposition);
  });

  it("refuses unknown, expired, wrong-method, and previous-account capabilities", async () => {
    let current = true;
    const url = mint("previewUrl", () => current);
    const fetchImpl = vi.fn();
    expect(
      (
        await serveDocumentAsset(
          new Request(url, { method: "PUT", body: "bad" }),
          {},
          fetchImpl
        )
      ).status
    ).toBe(405);
    current = false;
    expect(
      (await serveDocumentAsset(new Request(url), {}, fetchImpl)).status
    ).toBe(404);
    expect(openDocumentAssetDownload(url, vi.fn())).toBe(false);
    expect(
      (
        await serveDocumentAsset(
          new Request("app://renderer/document-assets/unknown"),
          {},
          fetchImpl
        )
      ).status
    ).toBe(404);
    const expired = mint("url", () => true, {
      expiresAt: new Date(Date.now() + 1000).toISOString(),
    });
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
    try {
      expect(
        (await serveDocumentAsset(new Request(expired), {}, fetchImpl)).status
      ).toBe(404);
    } finally {
      clock.mockRestore();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fences delayed body chunks after an account switch", async () => {
    let current = true;
    const url = mint("url", () => current);
    let enqueue: ((value: Uint8Array) => void) | undefined;
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        enqueue = (value) => controller.enqueue(value);
      },
    });
    const response = await serveDocumentAsset(
      new Request(url),
      {},
      vi.fn().mockResolvedValue(new Response(upstream))
    );
    const body = response.text();
    current = false;
    enqueue?.(new TextEncoder().encode("old account bytes"));
    await expect(body).rejects.toThrow("account changed");
  });

  it("rewrites inline images and lists, keeps unrelated payloads untouched, and rejects malformed asset fields", () => {
    const payload = JSON.stringify({ data: { url: storageUrl } });
    expect(
      rewriteDocumentAssetResponse("/documents/doc-1", payload, () => true)
    ).toBe(payload);
    const list = JSON.parse(
      rewriteDocumentAssetResponse(
        "/documents/doc-1/attachments",
        JSON.stringify({ data: [{ previewUrl: storageUrl }] }),
        () => true
      )
    );
    expect(list.data[0].previewUrl).toMatch(assetUrlPattern);
    const inline = JSON.parse(
      rewriteDocumentAssetResponse(
        "/documents/doc-1/attachments/resolve",
        JSON.stringify({
          data: { images: [{ url: storageUrl }], skipped: [] },
        }),
        () => true
      )
    );
    expect(inline.data.images[0].url).toMatch(assetUrlPattern);
    expect(() => mint("url", () => true, { expiresAt: "invalid" })).toThrow(
      "expiry"
    );
    expect(() =>
      rewriteDocumentAssetResponse(
        "/documents/doc-1/attachments",
        JSON.stringify({ data: { uploadUrl: "file:///private/file" } }),
        () => true
      )
    ).toThrow("HTTPS");
  });
});

const assetUrlPattern = /^app:\/\/renderer\/document-assets\//;
