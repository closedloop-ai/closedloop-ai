export type ShardSpec = {
  index: number;
  total: number;
};

export declare function parseShardSpec(
  raw: string | undefined | null
): ShardSpec | null;

export declare function selectShard<T>(
  files: readonly T[],
  shard: ShardSpec | null
): T[];
