# Compatibility Tracking

## `last-known-good.json`

This file is the **source of truth** for the last-known-good versions of each component in the compatibility matrix.

### Fields

- **`symphonyAlpha.sha`** — The commit SHA of this repository (`symphony-alpha`) that was part of the last verified compatible pair.
- **`closedloopElectron.sha`** — The commit SHA of the `closedloop-electron` app that was tested against the above `symphonyAlpha` SHA. These two SHAs represent a verified compatible pair.
- **`closedloopElectron.repo`** — The `org/repo` path (`closedloop-ai/closedloop-electron`) used by workflow checkout steps to reference the correct repository.
- **`lastUpdated`** — ISO-8601 timestamp of when this file was last updated.
- **`updatedBy`** — Either `"manual"` or the GitHub username of the person who made the update.

### Automated Updates

The auto-update workflow lives in the `closedloop-electron` repository. After a successful compatibility test run, it pushes an updated version of this file to `symphony-alpha` via a Personal Access Token (PAT). This keeps the file current without requiring manual intervention after each passing test.

### Manual Updates

To manually mark a new last-known-good pair:

1. Update `symphonyAlpha.sha` to the desired commit SHA from this repository.
2. Update `closedloopElectron.sha` to the commit SHA from `closedloop-ai/closedloop-electron` that was verified compatible.
3. Set `lastUpdated` to the current ISO-8601 timestamp.
4. Change `updatedBy` to your GitHub username.
5. Open a PR with the change for review.
