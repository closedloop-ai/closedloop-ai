/**
 * Rich selected-PR body used to prove the prototype's accepted safe-GFM
 * behavior without changing linked-artifact membership or acquisition.
 */
export const STRUCTURED_PR_DESCRIPTION = `# Summary

This PR includes **formatted delivery evidence** for the selected pull request.

- [x] Render safe GitHub Markdown
- [ ] Complete manual visual review

## Testing

### Surfaces

| Surface | State |
| --- | --- |
| Prototype | Ready for review |

Use \`pnpm --filter prototypes test\` and inspect the [merged behavior](https://github.com/closedloop-ai/symphony-alpha/pull/4675).

![Architecture diagram](https://example.com/architecture.png)

[![Build status](https://example.com/badge.svg)](https://example.com/build)

<img alt="Pasted architecture" src="https://example.com/pasted.png">

\`\`\`html
<!-- documented comment syntax -->
\`\`\`

<!-- ISS-5720-AUTOMATION-METADATA -->`;
