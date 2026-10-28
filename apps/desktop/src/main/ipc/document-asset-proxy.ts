import { randomUUID } from "node:crypto";
import { maxAttachmentSizeBytesForMimeType } from "@repo/api/src/types/attachment";
import { BoundedMap } from "@repo/lib/bounded-map";
import { resolveTranscriptAllowedOrigin } from "../renderer-dev-url.js";

/** Only main can mint these capabilities from authenticated attachment responses. */
export const DOCUMENT_ASSET_PATH_PREFIX = "/document-assets/";
const assetLifetimeMs = 10 * 60_000;
const assets = new BoundedMap<string, DocumentAsset>(4096);

type DocumentAsset = {
  url: string;
  method: "GET" | "PUT";
  expiresAt: number;
  isCurrent: () => boolean;
};

export function rewriteDocumentAssetResponse(
  pathname: string,
  bodyText: string,
  isCurrent: () => boolean
): string {
  if (!documentAttachmentResponsePattern.test(pathname)) {
    return bodyText;
  }
  const body: unknown = JSON.parse(bodyText);
  if (!(isObject(body) && (isObject(body.data) || Array.isArray(body.data)))) {
    return bodyText;
  }
  rewriteAssetObject(body.data, isCurrent);
  return JSON.stringify(body);
}

export async function serveDocumentAsset(
  request: Request,
  corsHeaders: Record<string, string>,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  const token = new URL(request.url).pathname.slice(
    DOCUMENT_ASSET_PATH_PREFIX.length
  );
  const asset = assets.get(token);
  if (!asset || asset.expiresAt <= Date.now() || !asset.isCurrent()) {
    assets.delete(token);
    return new Response("Not found", { status: 404 });
  }
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        "Access-Control-Allow-Methods": asset.method,
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }
  if (request.method !== asset.method) {
    return new Response("Method not allowed", { status: 405 });
  }
  const body =
    asset.method === "PUT" ? await readUploadBody(request) : undefined;
  if (body === null) {
    return new Response("Payload too large", { status: 413 });
  }
  if (!asset.isCurrent()) {
    return new Response("Not found", { status: 404 });
  }
  const headers = new Headers();
  const contentType = request.headers.get("Content-Type");
  if (contentType && body) {
    headers.set("Content-Type", contentType);
  }
  const upstream = await fetchImpl(asset.url, {
    method: asset.method,
    headers,
    ...(body ? { body } : {}),
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!asset.isCurrent()) {
    await upstream.body?.cancel();
    return new Response("Not found", { status: 404 });
  }
  const responseHeaders = new Headers(corsHeaders);
  responseHeaders.set("Cache-Control", "no-store");
  const responseType = upstream.headers.get("Content-Type");
  if (responseType) {
    responseHeaders.set("Content-Type", responseType);
  }
  const disposition = upstream.headers.get("Content-Disposition");
  if (disposition && attachmentDispositionPattern.test(disposition)) {
    responseHeaders.set("Content-Disposition", disposition);
  } else if (
    asset.method === "GET" &&
    !rasterImageTypePattern.test(responseType ?? "")
  ) {
    responseHeaders.set("Content-Disposition", "attachment");
  }
  return new Response(fenceAssetBody(upstream.body, asset.isCurrent), {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}

function rewriteAssetObject(value: unknown, isCurrent: () => boolean): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      rewriteAssetObject(item, isCurrent);
    }
    return;
  }
  if (!isObject(value)) {
    return;
  }
  for (const key of ["uploadUrl", "downloadUrl", "previewUrl", "url"]) {
    if (typeof value[key] !== "string") {
      continue;
    }
    const remote = new URL(value[key]);
    if (remote.protocol !== "https:" || remote.username || remote.password) {
      throw new Error(
        "Document attachment requires a signed HTTPS storage URL"
      );
    }
    // The configured API minted this URL; callers cannot supply a remote target.
    const expiresAt =
      typeof value.expiresAt === "string"
        ? Date.parse(value.expiresAt)
        : Date.now() + assetLifetimeMs;
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new Error("Document attachment URL expiry is invalid");
    }
    const token = randomUUID();
    assets.set(token, {
      url: remote.href,
      method: key === "uploadUrl" ? "PUT" : "GET",
      expiresAt,
      isCurrent,
    });
    value[key] = `app://renderer${DOCUMENT_ASSET_PATH_PREFIX}${token}`;
  }
  if (Array.isArray(value.images)) {
    rewriteAssetObject(value.images, isCurrent);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const documentAttachmentResponsePattern =
  /^\/documents\/[^/]+\/(?:attachments(?:\/resolve|\/[^/]+(?:\/download)?)?|context-attachments)$/;
const rasterImageTypePattern = /^image\/(?:png|jpeg|gif|webp|avif|bmp)(?:;|$)/i;

export function corsHeadersForDevOrigin(
  request: Request
): Record<string, string> {
  const allowedOrigin = resolveTranscriptAllowedOrigin(
    request.headers.get("Origin")
  );
  return allowedOrigin
    ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
    : {};
}

export function openDocumentAssetDownload(
  url: string,
  download: (url: string) => void
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (
    parsed.protocol !== "app:" ||
    parsed.hostname !== "renderer" ||
    !parsed.pathname.startsWith(DOCUMENT_ASSET_PATH_PREFIX)
  ) {
    return false;
  }
  const asset = assets.get(
    parsed.pathname.slice(DOCUMENT_ASSET_PATH_PREFIX.length)
  );
  if (
    asset?.method !== "GET" ||
    asset.expiresAt <= Date.now() ||
    !asset.isCurrent()
  ) {
    return false;
  }
  download(url);
  return true;
}

async function readUploadBody(request: Request): Promise<ArrayBuffer | null> {
  const reader = request.body?.getReader();
  if (!reader) {
    return new ArrayBuffer(0);
  }
  const maxBytes = maxAttachmentSizeBytesForMimeType(
    request.headers.get("Content-Type") ?? ""
  );
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result.buffer;
}

function fenceAssetBody(
  body: ReadableStream<Uint8Array> | null,
  isCurrent: () => boolean
): ReadableStream<Uint8Array> | null {
  const reader = body?.getReader();
  if (!reader) {
    return null;
  }
  return new ReadableStream({
    async pull(controller) {
      const chunk = await reader.read();
      if (!isCurrent()) {
        await reader.cancel();
        controller.error(new Error("Document attachment account changed"));
        return;
      }
      if (chunk.done) {
        controller.close();
      } else {
        controller.enqueue(chunk.value);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

const attachmentDispositionPattern = /^attachment(?:;|$)/i;
