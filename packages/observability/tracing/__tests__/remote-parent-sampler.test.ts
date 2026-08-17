import { context, SpanKind } from "@opentelemetry/api";
import {
  type Sampler,
  SamplingDecision,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-node";
import { describe, expect, it } from "vitest";
import { RemoteParentEntropySampler } from "../remote-parent-sampler";

// ---------------------------------------------------------------------------
// Remote-parent sampling cannot be forced by the caller (ISS-4659).
//
// `traceparent` is an untrusted request header on a public origin. Two
// defeats have to be closed, and the second is the subtle one:
//
//  1. Honouring the caller's sampled bit (`AlwaysOn`) = unbounded export on
//     demand.
//  2. Replacing it with `TraceIdRatioBasedSampler` ALSO fails, because that
//     sampler is deterministic on the trace id and the caller supplies the
//     trace id. An attacker searches for ids inside the accepted partition and
//     sends those on every request — 100% export through a sampler that looks
//     bounded.
//
// These tests use an attacker-favourable id and first PROVE the ratio sampler
// accepts it, so the attack premise is demonstrated rather than assumed. That
// proof earned its keep: the first draft of this file assumed the sampler read
// the trace id's low bytes, and the assertion failed — it XORs all four chunks.
// ---------------------------------------------------------------------------

/**
 * `TraceIdRatioBasedSampler` XORs the trace id's four 8-hex-digit chunks and
 * compares the result against `ratio * 2^32`. Four IDENTICAL chunks therefore
 * accumulate to 0 — the smallest possible value — so this id is accepted at
 * any non-zero ratio.
 *
 * That is the whole point: an attacker does not need to brute-force anything,
 * because the accepting ids are trivially constructible from a published
 * algorithm.
 */
const ATTACKER_CHOSEN_TRACE_ID = "aabbccddaabbccddaabbccddaabbccdd";
const SAMPLE_RATE = 0.1;

function sample(sampler: Sampler, traceId: string): SamplingDecision {
  return sampler.shouldSample(
    context.active(),
    traceId,
    "GET /branches",
    SpanKind.SERVER,
    {},
    []
  ).decision;
}

describe("the attack premise", () => {
  it("TraceIdRatioBasedSampler accepts an attacker-chosen trace id every time", () => {
    const ratioSampler = new TraceIdRatioBasedSampler(SAMPLE_RATE);

    const decisions = Array.from({ length: 20 }, () =>
      sample(ratioSampler, ATTACKER_CHOSEN_TRACE_ID)
    );

    // Deterministic and always sampled — so at a 10% nominal rate this single
    // id yields 100% export. That is the bypass.
    expect(
      decisions.every((d) => d === SamplingDecision.RECORD_AND_SAMPLED)
    ).toBe(true);
  });
});

describe("RemoteParentEntropySampler", () => {
  it("declines an attacker-chosen accepted id when the server draw says no", () => {
    const sampler = new RemoteParentEntropySampler(SAMPLE_RATE, () => 0.9);

    expect(sample(sampler, ATTACKER_CHOSEN_TRACE_ID)).toBe(
      SamplingDecision.NOT_RECORD
    );
  });

  it("samples when the server draw says yes, regardless of the caller's id", () => {
    const sampler = new RemoteParentEntropySampler(SAMPLE_RATE, () => 0.05);

    expect(sample(sampler, ATTACKER_CHOSEN_TRACE_ID)).toBe(
      SamplingDecision.RECORD_AND_SAMPLED
    );
  });

  it("is not deterministic on the trace id, so an id cannot be ground for", () => {
    const draws = [0.05, 0.9, 0.01, 0.99];
    let next = 0;
    const sampler = new RemoteParentEntropySampler(SAMPLE_RATE, () => {
      const value = draws[next];
      next += 1;
      return value;
    });

    const decisions = draws.map(() =>
      sample(sampler, ATTACKER_CHOSEN_TRACE_ID)
    );

    // Same id in, different answers out — the decision tracks server entropy,
    // not caller-controlled input.
    expect(decisions).toEqual([
      SamplingDecision.RECORD_AND_SAMPLED,
      SamplingDecision.NOT_RECORD,
      SamplingDecision.RECORD_AND_SAMPLED,
      SamplingDecision.NOT_RECORD,
    ]);
  });

  it("honours the configured rate over many server draws", () => {
    let draw = 0;
    // Sweep 0.00, 0.01 … 0.99 — a uniform source, so exactly the draws below
    // the rate should sample.
    const sampler = new RemoteParentEntropySampler(SAMPLE_RATE, () => {
      const value = draw / 100;
      draw += 1;
      return value;
    });

    const sampled = Array.from({ length: 100 }, () =>
      sample(sampler, ATTACKER_CHOSEN_TRACE_ID)
    ).filter((d) => d === SamplingDecision.RECORD_AND_SAMPLED).length;

    expect(sampled).toBe(10);
  });

  it("clamps an out-of-range rate so it cannot become always-on", () => {
    const sampler = new RemoteParentEntropySampler(17, () => 0.999_999);

    // Even a nonsense rate must not turn into unbounded export via a draw that
    // can never exceed 1.
    expect(sample(sampler, ATTACKER_CHOSEN_TRACE_ID)).toBe(
      SamplingDecision.RECORD_AND_SAMPLED
    );
    expect(
      sample(
        new RemoteParentEntropySampler(-5, () => 0),
        ATTACKER_CHOSEN_TRACE_ID
      )
    ).toBe(SamplingDecision.NOT_RECORD);
  });
});
