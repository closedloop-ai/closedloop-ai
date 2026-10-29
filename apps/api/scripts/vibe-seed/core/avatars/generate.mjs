import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAvatar } from "@dicebear/core";
import { create, meta, schema } from "@dicebear/lorelei";

const directory = process.argv[2];
if (!directory) {
  throw new Error("Pass the avatar directory containing options.json");
}

const { base, people } = JSON.parse(
  readFileSync(join(directory, "options.json"), "utf8")
);
for (const [handle, options] of Object.entries(people)) {
  writeFileSync(
    join(directory, `${handle}.svg`),
    createAvatar({ create, meta, schema }, { ...base, ...options }).toString()
  );
}
