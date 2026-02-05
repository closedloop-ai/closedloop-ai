/**
 * Deploy Failure Diagnostics
 *
 * Analyzes deployment failures and generates actionable reports.
 * Reads error context from environment and outputs structured diagnosis.
 */

import { readFile, writeFile } from "node:fs/promises";

const outputPath = process.env.DIAGNOSIS_OUTPUT_PATH || "diagnosis.json";

// Error patterns and their diagnoses
const ERROR_PATTERNS = [
  // Prisma / Database errors
  {
    category: "DATABASE",
    pattern: /P[0-9]{4}:/,
    name: "Prisma Error",
    extract: (log) => log.match(/P[0-9]{4}:[^\n]+/)?.[0],
    suggestions: [
      "Check if migrations are up to date: `prisma migrate status`",
      "Verify database connection string in environment",
      "Check for pending migrations that need to be applied",
    ],
  },
  {
    category: "DATABASE",
    pattern: /relation ".*" does not exist/i,
    name: "Missing Table/Relation",
    extract: (log) => log.match(/relation "[^"]+" does not exist/i)?.[0],
    suggestions: [
      "Run `prisma migrate deploy` to apply pending migrations",
      "Check if the migration creating this table was committed",
      "Verify you're connecting to the correct database",
    ],
  },
  {
    category: "DATABASE",
    pattern: /unique constraint|duplicate key/i,
    name: "Unique Constraint Violation",
    extract: (log) => log.match(/unique constraint "[^"]+"|duplicate key value/i)?.[0],
    suggestions: [
      "Check for duplicate data in seed scripts",
      "Verify upsert logic handles existing records",
      "Check if migration is idempotent",
    ],
  },
  {
    category: "DATABASE",
    pattern: /connection refused|ECONNREFUSED.*5432/i,
    name: "Database Connection Failed",
    extract: (log) => log.match(/connection refused[^\n]*/i)?.[0],
    suggestions: [
      "Verify DATABASE_URL is correctly set",
      "Check if database server is running and accessible",
      "Verify network/firewall rules allow connection",
    ],
  },

  // Build errors
  {
    category: "BUILD",
    pattern: /Type error:|error TS[0-9]+:/,
    name: "TypeScript Error",
    extract: (log) => {
      const match = log.match(/error TS[0-9]+:[^\n]+(\n\s+[^\n]+)*/);
      return match?.[0]?.slice(0, 500);
    },
    suggestions: [
      "Run `pnpm typecheck` locally to see full errors",
      "Check for missing type definitions or imports",
      "Verify all dependencies are installed",
    ],
  },
  {
    category: "BUILD",
    pattern: /Module not found|Cannot find module/i,
    name: "Missing Module",
    extract: (log) => log.match(/(?:Module not found|Cannot find module)[^\n]+/i)?.[0],
    suggestions: [
      "Run `pnpm install` to ensure dependencies are installed",
      "Check if the import path is correct",
      "Verify the package is in package.json",
    ],
  },
  {
    category: "BUILD",
    pattern: /ENOMEM|heap out of memory|JavaScript heap/i,
    name: "Out of Memory",
    extract: (log) => log.match(/(?:ENOMEM|heap out of memory|JavaScript heap)[^\n]*/i)?.[0],
    suggestions: [
      "Increase Node memory: `NODE_OPTIONS=--max_old_space_size=4096`",
      "Check for memory leaks in build process",
      "Consider splitting large builds",
    ],
  },
  {
    category: "BUILD",
    pattern: /ERR_PNPM_|pnpm ERR!/i,
    name: "pnpm Error",
    extract: (log) => log.match(/ERR_PNPM_[A-Z_]+[^\n]*/i)?.[0],
    suggestions: [
      "Try clearing pnpm cache: `pnpm store prune`",
      "Delete node_modules and pnpm-lock.yaml, reinstall",
      "Check for conflicting dependency versions",
    ],
  },

  // Environment errors
  {
    category: "ENVIRONMENT",
    pattern: /missing required.*environment|env.*not set|undefined.*env/i,
    name: "Missing Environment Variable",
    extract: (log) => log.match(/(?:missing|undefined)[^\n]*(?:env|environment)[^\n]*/i)?.[0],
    suggestions: [
      "Check Vercel environment variables are set for production",
      "Verify variable names match exactly (case-sensitive)",
      "Check if .env.local values need to be in Vercel dashboard",
    ],
  },
  {
    category: "ENVIRONMENT",
    pattern: /Invalid environment variables/i,
    name: "Environment Validation Failed",
    extract: (log) => {
      const match = log.match(/Invalid environment variables[\s\S]{0,500}/i);
      return match?.[0];
    },
    suggestions: [
      "Check t3-env validation in keys.ts files",
      "Verify all required variables are set",
      "Check variable format matches expected pattern",
    ],
  },

  // Vercel-specific errors
  {
    category: "VERCEL",
    pattern: /FUNCTION_INVOCATION_FAILED|EDGE_FUNCTION_INVOCATION/i,
    name: "Serverless Function Error",
    extract: (log) => log.match(/(?:FUNCTION_INVOCATION_FAILED|EDGE_FUNCTION)[^\n]*/i)?.[0],
    suggestions: [
      "Check function logs in Vercel dashboard",
      "Verify function doesn't exceed timeout/memory limits",
      "Check for unhandled exceptions in API routes",
    ],
  },
  {
    category: "VERCEL",
    pattern: /Build exceeded maximum duration/i,
    name: "Build Timeout",
    extract: (log) => "Build exceeded maximum duration",
    suggestions: [
      "Optimize build by reducing bundle size",
      "Check for infinite loops in build scripts",
      "Consider upgrading Vercel plan for longer builds",
    ],
  },

  // Git/Merge errors
  {
    category: "GIT",
    pattern: /CONFLICT|merge conflict|cannot merge/i,
    name: "Merge Conflict",
    extract: (log) => log.match(/(?:CONFLICT|merge conflict)[^\n]*/i)?.[0],
    suggestions: [
      "Resolve conflicts locally and push to main",
      "Check if production branch has diverged",
      "Consider rebasing main onto production first",
    ],
  },
  {
    category: "GIT",
    pattern: /not mergeable|MERGEABLE.*CONFLICTING/i,
    name: "PR Not Mergeable",
    extract: (log) => log.match(/(?:not mergeable|MERGEABLE[^\n]*)/i)?.[0],
    suggestions: [
      "Check PR for merge conflicts",
      "Verify all required status checks pass",
      "Check branch protection rules",
    ],
  },
];

function diagnose(errorLog) {
  const findings = [];

  for (const pattern of ERROR_PATTERNS) {
    if (pattern.pattern.test(errorLog)) {
      findings.push({
        category: pattern.category,
        name: pattern.name,
        detail: pattern.extract(errorLog) || "Pattern matched but no detail extracted",
        suggestions: pattern.suggestions,
      });
    }
  }

  // If no patterns matched, provide generic diagnosis
  if (findings.length === 0) {
    findings.push({
      category: "UNKNOWN",
      name: "Unrecognized Error",
      detail: errorLog.slice(0, 1000),
      suggestions: [
        "Check the full GitHub Actions log for details",
        "Search for the error message in project issues",
        "Review recent changes that might have caused this",
      ],
    });
  }

  return findings;
}

function formatSlackReport(diagnosis, context) {
  const { prUrl, runUrl, branch, sha, step, healthStatuses } = context;

  const categoryEmoji = {
    DATABASE: "🗄️",
    BUILD: "🔨",
    ENVIRONMENT: "🔐",
    VERCEL: "▲",
    GIT: "🔀",
    UNKNOWN: "❓",
  };

  const lines = [
    `*Deploy Failed* — requires attention`,
    "",
    `• *PR:* ${prUrl || "N/A"}`,
    `• *Branch:* \`${branch || "main"}\` → \`production\``,
    `• *Commit:* \`${sha?.slice(0, 7) || "N/A"}\``,
    `• *Failed Step:* ${step || "Unknown"}`,
    `• *Logs:* ${runUrl}`,
  ];

  // Add health check summary if available
  if (healthStatuses && Object.keys(healthStatuses).length > 0) {
    lines.push("");
    lines.push("*Health Checks:*");

    if (healthStatuses.vercel) {
      const v = healthStatuses.vercel;
      if (v.skipped) {
        lines.push("  • Vercel: ⊘ Skipped");
      } else if (v.ok) {
        lines.push("  • Vercel: ✓ All deployments ready");
      } else {
        const failed = v.deployments?.filter((d) => d.failed) || [];
        lines.push(`  • Vercel: ✗ ${failed.length} deployment(s) failed`);
      }
    }

    if (healthStatuses.database) {
      const d = healthStatuses.database;
      if (d.skipped) {
        lines.push("  • Database: ⊘ Skipped");
      } else if (d.ok) {
        const latency = d.checks?.connectivity?.latencyMs;
        lines.push(`  • Database: ✓ Healthy${latency ? ` (${latency}ms)` : ""}`);
      } else {
        const error = d.checks?.connectivity?.error || "Unknown error";
        lines.push(`  • Database: ✗ ${error}`);
      }
    }
  }

  lines.push("");
  lines.push("─────────────────────────");
  lines.push("*Diagnosis:*");
  lines.push("");

  for (const finding of diagnosis) {
    const emoji = categoryEmoji[finding.category] || "•";
    lines.push(`${emoji} *${finding.name}* (${finding.category})`);
    lines.push(`\`\`\`${finding.detail?.slice(0, 300) || "No details"}\`\`\``);
    lines.push("");
    lines.push("*Suggested fixes:*");
    for (const suggestion of finding.suggestions.slice(0, 3)) {
      lines.push(`  • ${suggestion}`);
    }
    lines.push("");
  }

  lines.push("─────────────────────────");
  lines.push("_Fix the issue and re-run the deploy workflow, or reply here for help._");

  return lines.join("\n");
}

function chunkForSlack(rawText, maxChunkSize = 2500) {
  // Avoid accidental termination of code fences in Slack
  const text = String(rawText || "").replace(/```/g, "`` `");
  if (!text.trim()) {
    return [];
  }

  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + maxChunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end;
  }

  return chunks.map((chunk, index) => {
    const header = `*Failure Logs* (chunk ${index + 1}/${chunks.length})`;
    return `${header}\n\`\`\`\n${chunk}\n\`\`\``;
  });
}

// Check for health check status files
async function loadHealthCheckStatus() {
  const statuses = {};

  try {
    const vercelRaw = await readFile("vercel-status.json", "utf-8").catch(() => null);
    if (vercelRaw) {
      statuses.vercel = JSON.parse(vercelRaw);
    }
  } catch {}

  try {
    const dbRaw = await readFile("db-status.json", "utf-8").catch(() => null);
    if (dbRaw) {
      statuses.database = JSON.parse(dbRaw);
    }
  } catch {}

  return statuses;
}

// Main execution
const errorLogPath = process.env.ERROR_LOG_PATH || "error_context.log";
const errorLog = await readFile(errorLogPath, "utf-8").catch(() => "");
const healthStatuses = await loadHealthCheckStatus();

const context = {
  prUrl: process.env.PR_URL,
  runUrl: process.env.RUN_URL,
  branch: process.env.DEPLOY_HEAD_BRANCH || "main",
  sha: process.env.GITHUB_SHA,
  step: process.env.FAILED_STEP,
  healthStatuses,
};

console.log("Analyzing deployment failure...");
console.log(`Error log length: ${errorLog.length} characters`);

const diagnosis = diagnose(errorLog);
const slackReport = formatSlackReport(diagnosis, context);
const slackLogChunks = chunkForSlack(errorLog);

const output = {
  timestamp: new Date().toISOString(),
  context,
  diagnosis,
  slackReport,
  slackLogChunks,
};

await writeFile(outputPath, JSON.stringify(output, null, 2));

console.log("\nDiagnosis complete:");
console.log(`- Found ${diagnosis.length} issue(s)`);
for (const d of diagnosis) {
  console.log(`  • ${d.category}: ${d.name}`);
}
console.log(`\nOutput written to ${outputPath}`);

// Also output the Slack report for easy capture
console.log("\n--- SLACK_REPORT_START ---");
console.log(slackReport);
console.log("--- SLACK_REPORT_END ---");
