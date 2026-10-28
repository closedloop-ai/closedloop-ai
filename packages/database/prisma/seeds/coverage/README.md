# Seed coverage (web)

One JSON file per Prisma model in `packages/database/prisma/schema.prisma`, named `<Model>.json`. It records whether the local seed fills that model, so the seeded local stack shows real data on every screen. One file per model means two PRs that add different models never conflict.

`packages/database/__tests__/seed-coverage.test.ts` blocks the PR when a model has no file, a file names a model that no longer exists, or a file is invalid. Desktop models have their own folder: `apps/desktop/prisma/seed-coverage/`.

## Statuses

| Status | File | Pick it when |
| --- | --- | --- |
| `seeded` | `{ "status": "seeded", "stage": "<stage>" }` | The seed writes rows for this model. `stage` names what writes them: `base-seed` for `packages/database/scripts/seed`, or the vibe seed stage name. |
| `skipped` | `{ "status": "skipped", "reason": "<one line>" }` | No screen reads the model (a queue, cursor, cache, token, or ledger). The reason says what reads it instead, specifically and truthfully. |
| `todo` | `{ "status": "todo" }` | A screen reads the model but nothing seeds it yet. |

Adding a model? `todo` is fine, so your PR stays small. The `vibe-seed-refresh` skill finds `todo` files and pays that debt by extending the seed and flipping them to `seeded`.

The loader and the comparison the tests and the vibe CLI use are `packages/database/scripts/seed/coverage.ts` and `packages/api/src/seed-coverage.ts`.
