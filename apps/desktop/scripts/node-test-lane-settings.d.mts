export declare function resolveTestTimeoutMs(env?: NodeJS.ProcessEnv): number;

export declare function resolveLaneConcurrency(): number;

export declare function resolveNodeCoverageEnabled(
  env?: NodeJS.ProcessEnv
): boolean;

export declare function laneConcurrencyFor(cores: number): number;
