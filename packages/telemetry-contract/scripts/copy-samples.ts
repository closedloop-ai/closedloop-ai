import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  SAMPLE_DIST_PATH,
  SAMPLE_SOURCE_PATH,
} from "./sample-export-constants";

if (!existsSync(SAMPLE_SOURCE_PATH)) {
  throw new Error("Missing source sample validate-perf-jsonl.sh");
}

const sourceStat = statSync(SAMPLE_SOURCE_PATH);
if (sourceStat.size === 0) {
  throw new Error("Source sample validate-perf-jsonl.sh is empty");
}

mkdirSync(dirname(SAMPLE_DIST_PATH), { recursive: true });
copyFileSync(SAMPLE_SOURCE_PATH, SAMPLE_DIST_PATH);
chmodSync(SAMPLE_DIST_PATH, sourceStat.mode % 0o1000);

if (statSync(SAMPLE_DIST_PATH).size === 0) {
  throw new Error("Copied sample validate-perf-jsonl.sh is empty");
}
