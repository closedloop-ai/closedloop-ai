import "server-only";

import { isUtf8 } from "node:buffer";
import type { Octokit } from "@octokit/rest";
import {
  SelectedPullRequestContentClassification,
  type SelectedPullRequestContentClassification as SelectedPullRequestContentClassificationType,
} from "@repo/api/src/types/selected-pull-request-evidence";
import { log } from "@repo/observability/log";

/** Structured event routed through the existing server error-log monitor. */
const MALFORMED_GITHUB_CONTENT_EVENT = "github_content_malformed_base64";

/**
 * Credential-agnostic file-content and diff-base reads (PLN-1525 step 3):
 * callers pass the Octokit obtained from the apps/api resolver layer (any
 * credential kind) instead of an installationId. No GITHUB_APP_* env needed.
 */

/**
 * Resolve the merge-base commit SHA between a base ref and a head ref. This is
 * the fork point GitHub uses for pull request "Files changed" diffs, so callers
 * rendering a PR-equivalent diff must compare against it rather than the base
 * branch's current tip (which drifts as the base advances). Returns null when
 * the comparison cannot be resolved.
 */
export async function getMergeBaseSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  base: string,
  head: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${base}...${head}`,
    });
    return data.merge_base_commit?.sha ?? null;
  } catch (error) {
    log.warn("[github/branch-files] Failed to resolve merge base", {
      owner,
      repo,
      base,
      head,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    return null;
  }
}

export type BoundedFileContentAtRefResult =
  | { status: "found"; content: string }
  | { status: "missing" | "not_file" | "too_large" | "unsupported_encoding" };

/**
 * Classified bounded content where only confirmed text carries decoded content;
 * binary and unknown variants never expose a string.
 */
export type ClassifiedBoundedFileContentAtRefResult =
  | {
      status: "found";
      classification: typeof SelectedPullRequestContentClassification.Text;
      content: string;
    }
  | {
      status: "found";
      classification: typeof SelectedPullRequestContentClassification.Binary;
    }
  | {
      status: "found";
      classification: typeof SelectedPullRequestContentClassification.Unknown;
    }
  | { status: "missing" | "not_file" | "too_large" | "unsupported_encoding" };

/**
 * Fetch bounded text content at a specific git ref. GitHub content/blob size
 * metadata is checked before decoding so explicit diff routes can reject
 * oversized files without materializing large strings in memory. The optional
 * caller signal reaches both content metadata and the blob fallback.
 */
export async function getBoundedFileContentAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedFileContentAtRefResult> {
  signal?.throwIfAborted();
  try {
    const result = await getBoundedGitHubContent(
      octokit,
      owner,
      repo,
      path,
      ref,
      maxBytes,
      signal
    );
    return result.status === "encoded"
      ? decodeBoundedGitHubTextContent(
          result.content,
          result.encoding,
          maxBytes
        )
      : result;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return { status: "missing" };
    }
    log.warn("[github/content] Failed to fetch bounded file content at ref", {
      owner,
      repo,
      path,
      ref,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

/**
 * Fetch and conservatively classify bounded selected-PR content before any
 * potentially lossy UTF-8 conversion. Only confirmed text carries content.
 */
export async function getClassifiedBoundedFileContentAtRef(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<ClassifiedBoundedFileContentAtRefResult> {
  signal?.throwIfAborted();
  try {
    const result = await getBoundedGitHubContent(
      octokit,
      owner,
      repo,
      path,
      ref,
      maxBytes,
      signal
    );
    if (result.status !== "encoded") {
      return result;
    }
    const classified = classifyBoundedGitHubContent(
      result.content,
      result.encoding,
      maxBytes
    );
    if (classified.diagnostic === "malformed_base64") {
      log.error(MALFORMED_GITHUB_CONTENT_EVENT, {
        owner,
        repo,
        path,
        ref,
        encoding: result.encoding,
      });
    }
    return classified.result;
  } catch (error) {
    if (signal?.aborted) {
      throw signal.reason;
    }
    const status = (error as { status?: number }).status;
    if (status === 404) {
      return { status: "missing" };
    }
    log.warn("[github/content] Failed to fetch bounded file content at ref", {
      owner,
      repo,
      path,
      ref,
      error: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

type BoundedGitHubContentResult =
  | { status: "encoded"; content: string; encoding: string | undefined }
  | { status: "not_file" | "too_large" };

async function getBoundedGitHubContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BoundedGitHubContentResult> {
  signal?.throwIfAborted();
  const request = signal ? { request: { signal } } : {};
  const { data } = await octokit.repos.getContent({
    owner,
    repo,
    path,
    ref,
    ...request,
  });
  signal?.throwIfAborted();

  // Directories return arrays; symlinks/submodules have no content field.
  if (Array.isArray(data) || data.type !== "file") {
    return { status: "not_file" };
  }
  if (exceedsDeclaredSize(data.size, maxBytes)) {
    return { status: "too_large" };
  }
  if (data.encoding === "none") {
    signal?.throwIfAborted();
    const { data: blob } = await octokit.git.getBlob({
      owner,
      repo,
      file_sha: data.sha,
      ...request,
    });
    signal?.throwIfAborted();
    if (exceedsDeclaredSize(blob.size, maxBytes)) {
      return { status: "too_large" };
    }
    return {
      status: "encoded",
      content: blob.content,
      encoding: blob.encoding,
    };
  }
  if (!("content" in data) || typeof data.content !== "string") {
    return { status: "not_file" };
  }
  return { status: "encoded", content: data.content, encoding: data.encoding };
}

function classifyBoundedGitHubContent(
  content: string,
  encoding: string | undefined,
  maxBytes: number
): ClassifiedContentResult {
  if (encoding === "base64") {
    const decodedSize = validBase64DecodedSize(content);
    if (decodedSize === null) {
      return {
        diagnostic: "malformed_base64",
        result: {
          status: "found",
          classification: SelectedPullRequestContentClassification.Unknown,
        },
      };
    }
    if (decodedSize > maxBytes) {
      return { result: { status: "too_large" } };
    }
  } else if (
    isDirectUtf8Encoding(encoding) &&
    Buffer.byteLength(content, "utf8") > maxBytes
  ) {
    return { result: { status: "too_large" } };
  }
  const bytes = decodeGitHubContentBytes(content, encoding);
  if (!bytes) {
    return { result: unsupportedEncoding(encoding) };
  }
  if (bytes.byteLength > maxBytes) {
    return { result: { status: "too_large" } };
  }
  if (isDirectUtf8Encoding(encoding) && bytes.toString("utf8") !== content) {
    return {
      result: {
        status: "found",
        classification: SelectedPullRequestContentClassification.Unknown,
      },
    };
  }
  const classification = classifyContentBytes(bytes);
  if (classification !== SelectedPullRequestContentClassification.Text) {
    return { result: { status: "found", classification } };
  }
  return {
    result: {
      status: "found",
      classification,
      content: bytes.toString("utf-8"),
    },
  };
}

type ClassifiedContentResult = {
  diagnostic?: "malformed_base64";
  result: ClassifiedBoundedFileContentAtRefResult;
};

function classifyContentBytes(
  bytes: Buffer
): SelectedPullRequestContentClassificationType {
  if (bytes.includes(0)) {
    return SelectedPullRequestContentClassification.Binary;
  }
  return isUtf8(bytes)
    ? SelectedPullRequestContentClassification.Text
    : SelectedPullRequestContentClassification.Unknown;
}

function decodeGitHubContentBytes(
  content: string,
  encoding: string | undefined
): Buffer | null {
  if (encoding === "base64") {
    return Buffer.from(content, "base64");
  }
  if (encoding === "utf-8" || encoding === "utf8") {
    return Buffer.from(content, "utf8");
  }
  return null;
}

function isDirectUtf8Encoding(encoding: string | undefined) {
  return encoding === "utf-8" || encoding === "utf8";
}

function validBase64DecodedSize(content: string): number | null {
  let dataCharacters = 0;
  let paddingCharacters = 0;
  let reachedPadding = false;
  for (const character of content) {
    if (isBase64Whitespace(character)) {
      continue;
    }
    if (character === "=") {
      reachedPadding = true;
      paddingCharacters += 1;
      if (paddingCharacters > 2) {
        return null;
      }
      continue;
    }
    if (reachedPadding || !isBase64DataCharacter(character)) {
      return null;
    }
    dataCharacters += 1;
  }

  const totalCharacters = dataCharacters + paddingCharacters;
  if (paddingCharacters > 0) {
    if (
      totalCharacters % 4 !== 0 ||
      (paddingCharacters === 1 && dataCharacters % 4 !== 3) ||
      (paddingCharacters === 2 && dataCharacters % 4 !== 2)
    ) {
      return null;
    }
    return (totalCharacters / 4) * 3 - paddingCharacters;
  }
  return dataCharacters % 4 === 1 ? null : Math.floor((dataCharacters * 3) / 4);
}

function isBase64Whitespace(character: string) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

function isBase64DataCharacter(character: string) {
  const code = character.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    character === "+" ||
    character === "/"
  );
}

function decodeBoundedGitHubTextContent(
  content: string,
  encoding: string | undefined,
  maxBytes: number
): BoundedFileContentAtRefResult {
  if (encoding === "base64") {
    const buffer = Buffer.from(content, "base64");
    if (buffer.byteLength > maxBytes) {
      return { status: "too_large" };
    }
    return { status: "found", content: buffer.toString("utf-8") };
  }

  if (encoding === "utf-8" || encoding === "utf8") {
    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      return { status: "too_large" };
    }
    return { status: "found", content };
  }

  log.warn("[github/content] Unsupported file encoding", {
    encoding: encoding ?? null,
  });
  return { status: "unsupported_encoding" };
}

function unsupportedEncoding(
  encoding: string | undefined
): ClassifiedBoundedFileContentAtRefResult {
  log.warn("[github/content] Unsupported file encoding", {
    encoding: encoding ?? null,
  });
  return { status: "unsupported_encoding" };
}

function exceedsDeclaredSize(
  size: number | null | undefined,
  maxBytes: number
) {
  return (
    Number.isFinite(maxBytes) && typeof size === "number" && size > maxBytes
  );
}
