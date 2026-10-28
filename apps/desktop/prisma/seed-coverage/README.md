# Seed coverage (Desktop)

One JSON file per Prisma model in `apps/desktop/prisma/schema.prisma`, named `<Model>.json`. It records whether the seeded Desktop profile fills that model, so every Desktop view shows real data. One file per model means two PRs that add different models never conflict. A model marked `@@ignore` is not in the generated client and needs no file.

`apps/desktop/test/seed-coverage.test.ts` blocks the PR when a model has no file, a file names a model that no longer exists, or a file is invalid. Web models have their own folder: `packages/database/prisma/seeds/coverage/`.

## Statuses

| Status | File | Pick it when |
| --- | --- | --- |
| `seeded` | `{ "status": "seeded", "stage": "<stage>" }` | The Desktop profile seed writes rows for this model. `stage` names what writes them: `golden-import` for the golden-corpus import, or the profile seed step's name. |
| `skipped` | `{ "status": "skipped", "reason": "<one line>" }` | No view reads the model (a sync outbox, cursor, heal marker, or raw capture). The reason says what reads it instead, specifically and truthfully. |
| `todo` | `{ "status": "todo" }` | A view reads the model but the profile seed does not fill it yet, including models only e2e fixtures seed today. |

Adding a model? `todo` is fine, so your PR stays small. The `vibe-seed-refresh` skill finds `todo` files and pays that debt by extending the seed and flipping them to `seeded`.

The loader and the comparison the test and the vibe CLI use are `apps/desktop/scripts/seed-coverage.ts` and `packages/api/src/seed-coverage.ts`.
