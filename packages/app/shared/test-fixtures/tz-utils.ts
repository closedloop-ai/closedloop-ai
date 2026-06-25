type ProcessLike = {
  env: Record<string, string | undefined>;
};

const testGlobal = globalThis as typeof globalThis & {
  process?: ProcessLike;
};

/**
 * Restore the process timezone mutation used by date formatter tests without
 * requiring Node global types in renderer-facing TypeScript projects.
 */
export function restoreTimeZone(value: string | undefined): void {
  const env = testGlobal.process?.env;
  if (!env) {
    return;
  }

  if (value === undefined) {
    Reflect.deleteProperty(env, "TZ");
    return;
  }
  env.TZ = value;
}
