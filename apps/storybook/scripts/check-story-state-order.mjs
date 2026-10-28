// `pnpm check:storybook-state-order` (ISS-12332): the state order check on
// its own, so it runs where a story change is actually stopped before merge:
// the husky pre-push gate (through `pnpm verify --scope=push`) and the
// required `lint` job. `validate:catalog` runs the same check inside
// `storybook-build`. The rule is in story-state-order.mjs.
import process from "node:process";
import { checkStateOrder } from "./story-state-order.mjs";
import {
  collectAppCoreStoryFiles,
  collectDesktopStoryFiles,
  collectRootStoryFiles,
} from "./sync-component-catalog.mjs";

const { checked, errors } = checkStateOrder([
  ...collectRootStoryFiles(),
  ...collectAppCoreStoryFiles(),
  ...collectDesktopStoryFiles(),
]);
for (const message of errors) {
  console.error(message);
}
if (errors.length > 0) {
  process.exitCode = 1;
} else {
  console.log(`Storybook state order: ${checked} page-tree entries in order.`);
}
