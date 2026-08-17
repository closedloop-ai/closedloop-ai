// ---------------------------------------------------------------------------
// Sampling decision for spans whose parent arrived over the wire (ISS-4659).
//
// `traceparent` is an untrusted request header on a public origin, so the
// remote-parent branch of `ParentBasedSampler` is an attacker-reachable input
// to our Datadog ingest bill. Two things have to hold:
//
//  1. The caller's sampled bit must not be honoured verbatim — that is
//     `AlwaysOn`, i.e. unbounded export on demand.
//  2. The replacement decision must not be derived from the TRACE ID either.
//     `TraceIdRatioBasedSampler` is deterministic on the trace id, and the
//     caller chooses the trace id: they can search for ids that land inside the
//     accepted partition and send those on every request, which reproduces
//     100% export through a sampler that looks bounded.
//
// So the decision uses server-side entropy the caller cannot see or influence.
// Root spans keep `TraceIdRatioBasedSampler` — we mint those trace ids
// ourselves, so determinism there is a feature (a consistent decision across a
// trace) rather than an attack surface.
//
// Cost of this choice: a remote-parented trace is no longer guaranteed to be
// sampled end-to-end, because our decision is independent of the caller's.
// Within this service local children still inherit the local root's decision
// via `ParentBasedSampler`, so individual traces stay coherent.
// ---------------------------------------------------------------------------

import {
  type Sampler,
  SamplingDecision,
  type SamplingResult,
} from "@opentelemetry/sdk-trace-node";

/** Source of the sampling draw. Injected so tests are deterministic. */
export type RandomSource = () => number;

/**
 * Samples at a fixed ratio using server-controlled entropy, ignoring every
 * caller-supplied value — trace id included.
 */
export class RemoteParentEntropySampler implements Sampler {
  private readonly ratio: number;
  private readonly random: RandomSource;

  constructor(ratio: number, random: RandomSource = Math.random) {
    // Clamped defensively: a ratio outside [0,1] would silently mean
    // always-on or always-off, which is exactly the property this class exists
    // to guarantee cannot be reached from outside.
    this.ratio = Math.min(1, Math.max(0, ratio));
    this.random = random;
  }

  shouldSample(): SamplingResult {
    return {
      decision:
        this.random() < this.ratio
          ? SamplingDecision.RECORD_AND_SAMPLED
          : SamplingDecision.NOT_RECORD,
    };
  }

  toString(): string {
    return `RemoteParentEntropySampler{${this.ratio}}`;
  }
}
