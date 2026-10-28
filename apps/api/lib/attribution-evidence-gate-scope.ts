import { AsyncLocalStorage } from "node:async_hooks";

/**
 * ISS-12552 (PRD-800 "Rollout"): one `attribution-evidence-policy` answer
 * per organization for a whole request. A request can reach more than one read
 * site (a link write's receipt and its implementation derivation; sync
 * ingest's payload gate and its post-commit derivation), and each reads the
 * flag itself. Inside this scope they share one evaluation, so they cannot
 * disagree and PostHog is asked once.
 *
 * Outside a scope every read evaluates on its own. A nested call joins the
 * enclosing scope rather than opening a second one.
 *
 * The AsyncLocalStorage lives on a `Symbol.for` slot, not a module binding, for
 * the reason `request-span-attribution.ts` documents: a bundler can give two
 * importers separate copies of this module.
 */
export function runWithAttributionEvidenceGate<T>(
  handler: () => Promise<T>
): Promise<T> {
  if (storage().getStore()) {
    return handler();
  }
  return storage().run(new Map(), handler);
}

/**
 * The scope's answer for `organizationId`, evaluating it on the first read. A
 * read outside any scope evaluates every time.
 */
export function memoizeAttributionEvidenceGate(
  organizationId: string,
  evaluate: () => Promise<boolean | null>
): Promise<boolean | null> {
  const answers = storage().getStore();
  if (!answers) {
    return evaluate();
  }
  const held = answers.get(organizationId);
  if (held) {
    return held.pending;
  }
  const answer: GateAnswer = { pending: evaluate() };
  answer.pending.then(
    (settled) => {
      answer.settled = settled;
    },
    () => undefined
  );
  answers.set(organizationId, answer);
  return answer.pending;
}

/**
 * The answer this request scope already holds for `organizationId`, without
 * evaluating anything: `undefined` when the request has not read it, or reads
 * it outside any scope.
 */
export function settledAttributionEvidenceGate(
  organizationId: string
): boolean | null | undefined {
  return storage().getStore()?.get(organizationId)?.settled;
}

const ATTRIBUTION_EVIDENCE_GATE_STORAGE = Symbol.for(
  "closedloop.api.attributionEvidenceGateStorage"
);

type GateAnswer = {
  pending: Promise<boolean | null>;
  settled?: boolean | null;
};

type GateAnswers = Map<string, GateAnswer>;

type ScopeGlobal = typeof globalThis & {
  [ATTRIBUTION_EVIDENCE_GATE_STORAGE]?: AsyncLocalStorage<GateAnswers>;
};

function storage(): AsyncLocalStorage<GateAnswers> {
  const slot = globalThis as ScopeGlobal;
  slot[ATTRIBUTION_EVIDENCE_GATE_STORAGE] ??= new AsyncLocalStorage();
  return slot[ATTRIBUTION_EVIDENCE_GATE_STORAGE];
}
