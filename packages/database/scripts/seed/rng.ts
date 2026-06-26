import { createHash } from "node:crypto";
import type { SeedClock } from "./profiles";

export type SeedRng = {
  next(): number;
  integer(min: number, max: number): number;
  pick<T>(values: readonly T[]): T;
};

export function hashSeedToUint32(seed: string): number {
  const hash = createHash("sha256").update(seed).digest();
  return hash.readUInt32BE(0);
}

export function createSeedRng(seed: string): SeedRng {
  let state = hashSeedToUint32(seed);
  const next = () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 PRNG uses defined uint32 bit operations.
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 PRNG uses defined uint32 bit operations.
    t = Math.imul(t ^ (t >>> 15), t | 1);
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 PRNG uses defined uint32 bit operations.
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    // biome-ignore lint/suspicious/noBitwiseOperators: mulberry32 PRNG uses defined uint32 bit operations.
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  return {
    next,
    integer(min: number, max: number) {
      if (max < min) {
        throw new Error(`SeedRng.integer: max ${max} must be >= min ${min}`);
      }
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(values: readonly T[]): T {
      if (values.length === 0) {
        throw new Error("SeedRng.pick: values must not be empty");
      }
      return values[Math.floor(next() * values.length)];
    },
  };
}

export function seedDate(clock: SeedClock, offsetMs = 0): Date {
  return new Date(clock.baseDate.getTime() + offsetMs);
}

export function distributeLongTail(total: number, buckets: number): number[] {
  if (buckets <= 0) {
    throw new Error("distributeLongTail: buckets must be positive");
  }
  if (total < 0) {
    throw new Error("distributeLongTail: total must be non-negative");
  }
  if (total === 0) {
    return Array.from({ length: buckets }, () => 0);
  }

  const weights = Array.from(
    { length: buckets },
    (_unused, index) => 1 / (index + 1) ** 1.35
  );
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0);
  const allocations = weights.map((weight) =>
    Math.floor((weight / weightTotal) * total)
  );
  let assigned = allocations.reduce((sum, count) => sum + count, 0);
  let index = 0;
  while (assigned < total) {
    allocations[index % allocations.length]++;
    assigned++;
    index++;
  }
  return allocations;
}

export function buildLongTailIndexSequence(
  total: number,
  buckets: number
): number[] {
  if (total === 0) {
    return [];
  }
  const allocations = distributeLongTail(total, buckets);
  return allocations.flatMap((count, index) =>
    Array.from({ length: count }, () => index)
  );
}
