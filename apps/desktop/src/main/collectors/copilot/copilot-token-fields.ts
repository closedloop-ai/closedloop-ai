/**
 * @file copilot-token-fields.ts
 * @description Token-count field helpers shared by the Copilot chat/CLI
 * parsers. `TokenFields` is the canonical fresh-shape token bundle
 * (input/output/cacheRead/cacheWrite); the helpers read it off a raw usage
 * payload and accumulate/merge it. Extracted from `copilot-parser.ts` to keep
 * that file under its size ceiling.
 */
import {
  addStorageTokenCounts,
  readStorageTokenCountAlias,
} from "../../cost/token-counts.js";

export type TokenFields = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

// Canonical fresh shape (see NormalizedTokenCounts): Copilot reports `input`
// as FRESH/uncached with cache_read/cache_write as separate additive fields
// (confirmed by fixtures where cache_read far exceeds input — impossible under
// an inclusive total), so they are read verbatim — no subtraction.
export function readCopilotUsage(
  usage: Record<string, unknown>,
  context: string
): TokenFields {
  const input = readStorageTokenCountAlias(usage, `${context}.input`, [
    "input_tokens",
    "prompt_tokens",
  ]);
  const output = addStorageTokenCounts(
    readStorageTokenCountAlias(usage, `${context}.output`, [
      "output_tokens",
      "completion_tokens",
    ]),
    // FEA-3728: `reasoning_tokens` is reasoning counted SEPARATELY from output,
    // so folding it in is correct. `reasoning_output_tokens` is deliberately
    // EXCLUDED — it is the OpenAI/Codex field FEA-3126/FEA-3527 proved is a
    // SUBSET of `output_tokens` (already inside the output figure above), so an
    // OpenAI-backed Copilot payload that reports it would double-count reasoning
    // into output if it were folded here.
    readStorageTokenCountAlias(usage, `${context}.reasoning`, [
      "reasoning_tokens",
    ]),
    `${context}.output_with_reasoning`
  );
  const cacheRead = readStorageTokenCountAlias(usage, `${context}.cache_read`, [
    "cache_read_tokens",
    "cached_input_tokens",
  ]);
  const cacheWrite = readStorageTokenCountAlias(
    usage,
    `${context}.cache_write`,
    ["cache_write_tokens", "cache_creation_input_tokens"]
  );
  return { input, output, cacheRead, cacheWrite };
}

export function addTokenFields(
  target: TokenFields,
  next: TokenFields,
  context: string
): void {
  target.input = addStorageTokenCounts(
    target.input,
    next.input,
    `${context}.input`
  );
  target.output = addStorageTokenCounts(
    target.output,
    next.output,
    `${context}.output`
  );
  target.cacheRead = addStorageTokenCounts(
    target.cacheRead,
    next.cacheRead,
    `${context}.cache_read`
  );
  target.cacheWrite = addStorageTokenCounts(
    target.cacheWrite,
    next.cacheWrite,
    `${context}.cache_write`
  );
}

export function maxTokenFields(target: TokenFields, next: TokenFields): void {
  target.input = Math.max(target.input, next.input);
  target.output = Math.max(target.output, next.output);
  target.cacheRead = Math.max(target.cacheRead, next.cacheRead);
  target.cacheWrite = Math.max(target.cacheWrite, next.cacheWrite);
}

export function hasTokenFields(tokens: TokenFields): boolean {
  return Boolean(
    tokens.input || tokens.output || tokens.cacheRead || tokens.cacheWrite
  );
}
