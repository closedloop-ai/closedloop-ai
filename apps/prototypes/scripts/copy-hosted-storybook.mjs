// ISS-10991: publishes `storybook#build`'s output at `/storybook` instead of
// running a second Storybook build here. Only a turbo run guarantees that
// output is this commit's: turbo runs or restores `storybook#build` first, and
// sets `TURBO_HASH` for every task it runs. Run bare, this would copy whatever
// `storybook-static` was left on disk, however old.
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

const appRoot = path.resolve(import.meta.dirname, "..");
const source = path.resolve(appRoot, "../storybook/storybook-static");
const target = path.join(appRoot, "public/storybook");
const rerun =
  "Run `pnpm turbo run build --filter=prototypes` from the repo root.";

if (!process.env.TURBO_HASH) {
  fail(
    `This build copies ${source}, which only a turbo run guarantees is this commit's Storybook build. ${rerun}`
  );
}
if (!existsSync(path.join(source, "index.html"))) {
  fail(
    `${source} holds no Storybook build: \`storybook#build\` must run first. ${rerun}`
  );
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

function fail(message) {
  console.error(message);
  process.exit(1);
}
