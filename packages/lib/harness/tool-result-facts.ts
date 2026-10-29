/**
 * ISS-12552: facts read from a tool result BEFORE the parser
 * caps it at {@link truncateText}'s 4 KB. A write's receipt sits at the end of
 * its JSON body and a script prints its operation ids wherever it likes, so
 * both are gone from the capped `output` on any large result. These facts are
 * what operation-claim extraction reads instead; they never classify.
 */
import {
  OPERATION_ID_PREFIX,
  type OperationReceipt,
  parseOperationId,
} from "@repo/api/src/types/attribution-evidence";
import { operationReceiptSchema } from "@repo/api/src/types/attribution-evidence-schema";
import {
  type ClosedloopMcpToolName,
  isClosedloopMcpToolName,
} from "@repo/api/src/types/closedloop-operation-semantics";
import { ToolResultState } from "@repo/api/src/types/operation-claims";
import { buildSlugPrefixAlternation } from "@repo/api/src/types/slug-prefix";
import { z } from "zod";
import { isRecord } from "./type-guards";
import type { NormalizedToolUse } from "./types";

/** The record a ClosedLoop tool response root names. */
export type ClosedloopResultEntity = {
  id?: string;
  slug?: string;
  version?: number;
};

/** What a ClosedLoop MCP tool's own response root says it did. */
export type ClosedloopResultFacts = {
  isError: boolean;
  operationReceipt?: OperationReceipt;
  primaryEntity?: ClosedloopResultEntity;
  /** Other ClosedLoop slugs anywhere in the result, at most 200. */
  nestedSlugs: string[];
};

export const MAX_NESTED_RESULT_SLUGS = 200;
export const MAX_SHELL_OPERATION_IDS = 50;

const CLOSEDLOOP_SERVER = "closedloop";
const CLOSEDLOOP_TOOL_PREFIX = "mcp__closedloop__";
const CLOSEDLOOP_NAMESPACE = "mcp__closedloop";
const OPERATION_ID_RE = new RegExp(
  `${OPERATION_ID_PREFIX}[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}`,
  "g"
);
const RESULT_SLUG_RE = new RegExp(
  String.raw`\b(?:${buildSlugPrefixAlternation()})-\d+\b`,
  "g"
);
/** Claude Code's spill of an oversized result to a side file. */
const CLAUDE_PERSISTED_OUTPUT = "<persisted-output>";
/** Codex's middle elision of an oversized result. */
const CODEX_ELISION_RE = /…\d+ tokens truncated…/;

/** A tool call's name fields, in each harness's spelling. */
export type ToolCallNaming = {
  name: string;
  mcpServer?: string;
  mcpMethod?: string;
  mcpNamespace?: string;
};

/**
 * The method a call invoked on the ClosedLoop MCP server, as the harness
 * spelled it, or null for any other tool. Reads Claude's
 * `mcp__closedloop__<tool>` name, Codex's separate server and method, and a
 * Codex `function_call` namespace. A method the semantics table does not know
 * is still returned, so it can be counted as unsupported.
 */
export function readClosedloopServerMethod(
  call: ToolCallNaming
): string | null {
  if (call.mcpServer === CLOSEDLOOP_SERVER) {
    return call.mcpMethod ?? null;
  }
  if (call.mcpNamespace === CLOSEDLOOP_NAMESPACE) {
    return call.name;
  }
  if (call.name.startsWith(CLOSEDLOOP_TOOL_PREFIX)) {
    return call.name.slice(CLOSEDLOOP_TOOL_PREFIX.length) || null;
  }
  return null;
}

/**
 * The ClosedLoop tool a call invoked, or null for any other tool or a method
 * the semantics table does not know. Codex rewrites `-` to `_` in a namespaced
 * tool name, so an unknown underscore spelling is retried with hyphens
 * (`create_branch_artifact` is underscored natively and matches first).
 */
export function resolveClosedloopToolName(
  call: ToolCallNaming
): ClosedloopMcpToolName | null {
  const method = readClosedloopServerMethod(call);
  if (!method) {
    return null;
  }
  if (isClosedloopMcpToolName(method)) {
    return method;
  }
  const hyphenated = method.replaceAll("_", "-");
  return isClosedloopMcpToolName(hyphenated) ? hyphenated : null;
}

/** The result fields a tool use carries. */
export type ToolResultFacts = Pick<
  NormalizedToolUse,
  "resultState" | "closedloopResultFacts" | "shellOperationIds"
>;

/**
 * Facts read from a result before its tool is known, as in a Claude sidecar
 * file where results join their calls by id later. Pick the tool's half with
 * {@link selectToolResultFacts}. A ClosedLoop response root is read only from
 * a body that is a JSON object, so other tools' large results are not parsed.
 */
export type UntypedToolResultFacts = {
  resultState: ToolResultState;
  isError: boolean;
  closedloop?: ClosedloopResultFacts;
  operationIds: string[];
};

/**
 * Record a tool's result facts from its FULL text. Every harness parser calls
 * this where it caps `output`, before the cap.
 */
export function recordToolResultFacts(
  toolUse: NormalizedToolUse,
  resultText: string | null | undefined,
  isError: boolean
): void {
  Object.assign(toolUse, readToolResultFacts(toolUse, resultText, isError));
}

/** The result facts for a known tool, from its FULL text. */
export function readToolResultFacts(
  call: ToolCallNaming,
  resultText: string | null | undefined,
  isError: boolean
): ToolResultFacts {
  const resultState = readToolResultState(resultText, isError);
  if (resolveClosedloopToolName(call)) {
    return {
      resultState,
      closedloopResultFacts: readClosedloopResultFacts(resultText, isError),
    };
  }
  const operationIds = readShellOperationIds(resultText);
  return {
    resultState,
    ...(operationIds.length > 0 ? { shellOperationIds: operationIds } : {}),
  };
}

export function readUntypedToolResultFacts(
  resultText: string | null | undefined,
  isError: boolean
): UntypedToolResultFacts {
  const looksLikeJsonObject = resultText?.trimStart().startsWith("{") === true;
  return {
    resultState: readToolResultState(resultText, isError),
    isError,
    ...(looksLikeJsonObject
      ? { closedloop: readClosedloopResultFacts(resultText, isError) }
      : {}),
    operationIds: readShellOperationIds(resultText),
  };
}

export function selectToolResultFacts(
  call: ToolCallNaming,
  facts: UntypedToolResultFacts
): ToolResultFacts {
  if (resolveClosedloopToolName(call)) {
    return {
      resultState: facts.resultState,
      closedloopResultFacts: facts.closedloop ?? {
        isError: facts.isError,
        nestedSlugs: [],
      },
    };
  }
  return {
    resultState: facts.resultState,
    ...(facts.operationIds.length > 0
      ? { shellOperationIds: facts.operationIds }
      : {}),
  };
}

/** Whether the harness elided part of this result before recording it. */
export function readToolResultState(
  resultText: string | null | undefined,
  isError: boolean
): ToolResultState {
  if (
    resultText &&
    (resultText.trimStart().startsWith(CLAUDE_PERSISTED_OUTPUT) ||
      CODEX_ELISION_RE.test(resultText))
  ) {
    return ToolResultState.SourceTruncated;
  }
  return isError ? ToolResultState.Error : ToolResultState.Present;
}

/**
 * The facts a ClosedLoop tool's response root states: its receipt, the record
 * it names, and the other slugs it mentions. The receipt and the entity are
 * read from the root only; a slug nested in a list or a body is a mention.
 */
export function readClosedloopResultFacts(
  resultText: string | null | undefined,
  isError: boolean
): ClosedloopResultFacts {
  const root = parseJsonRoot(resultText);
  const operationReceipt = root ? readReceipt(root.operationReceipt) : null;
  const primaryEntity = root ? readEntity(root) : null;
  const nestedSlugs = collectSlugs(resultText ?? "", primaryEntity?.slug);
  return {
    isError,
    ...(operationReceipt ? { operationReceipt } : {}),
    ...(primaryEntity ? { primaryEntity } : {}),
    nestedSlugs,
  };
}

/**
 * Every well-formed `clop_` operation id a shell call printed, in order, once
 * each, at most {@link MAX_SHELL_OPERATION_IDS}.
 */
export function readShellOperationIds(
  resultText: string | null | undefined
): string[] {
  const ids = new Set<string>();
  for (const match of (resultText ?? "").matchAll(OPERATION_ID_RE)) {
    if (ids.size >= MAX_SHELL_OPERATION_IDS) {
      break;
    }
    const receiptId = parseOperationId(match[0]);
    if (receiptId) {
      ids.add(`${OPERATION_ID_PREFIX}${receiptId}`);
    }
  }
  return [...ids];
}

function parseJsonRoot(
  text: string | null | undefined
): Record<string, unknown> | null {
  if (!text) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readReceipt(value: unknown): OperationReceipt | null {
  const receipt = operationReceiptSchema.safeParse(value).data;
  // Only the two contract fields, whatever else the response carried.
  return receipt
    ? { operationId: receipt.operationId, outcome: receipt.outcome }
    : null;
}

/** Each field read on its own, so one malformed field drops only itself. */
const resultEntitySchema = z.object({
  id: z.string().optional().catch(undefined),
  slug: z.string().optional().catch(undefined),
  latestVersion: z.number().int().optional().catch(undefined),
});

function readEntity(
  root: Record<string, unknown>
): ClosedloopResultEntity | null {
  const { id, slug, latestVersion } = resultEntitySchema.parse(root);
  const entity: ClosedloopResultEntity = {
    ...(id === undefined ? {} : { id }),
    ...(slug === undefined ? {} : { slug }),
    ...(latestVersion === undefined ? {} : { version: latestVersion }),
  };
  return entity.id || entity.slug ? entity : null;
}

function collectSlugs(text: string, primarySlug: string | undefined): string[] {
  const slugs = new Set<string>();
  for (const match of text.matchAll(RESULT_SLUG_RE)) {
    if (slugs.size >= MAX_NESTED_RESULT_SLUGS) {
      break;
    }
    if (match[0] !== primarySlug) {
      slugs.add(match[0]);
    }
  }
  return [...slugs];
}
