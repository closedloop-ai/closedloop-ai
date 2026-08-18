export declare const COVERAGE_MERGE_HEAP_MB: number;

export declare function withCoverageMergeHeap(
  env: NodeJS.ProcessEnv,
  heapMb?: number
): NodeJS.ProcessEnv;

export type CoverageLane = {
  name: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export declare function buildCoverageLanes(
  env: NodeJS.ProcessEnv
): CoverageLane[];
