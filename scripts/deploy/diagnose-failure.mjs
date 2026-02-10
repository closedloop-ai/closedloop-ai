/**
 * Deploy Failure Diagnostics
 *
 * Analyzes deployment failures and generates actionable reports.
 * Reads error context from environment and outputs structured diagnosis.
 */

import { readFile, writeFile } from "node:fs/promises";

const outputPath = process.env.DIAGNOSIS_OUTPUT_PATH || "diagnosis.json";

// Regex patterns extracted to top-level constants
const PRISMA_ERROR_PATTERN = /P[0-9]{4}:/;
const PRISMA_ERROR_EXTRACT = /P[0-9]{4}:[^\n]+/;
const RELATION_MISSING_PATTERN = /relation ".*" does not exist/i;
const RELATION_MISSING_EXTRACT = /relation "[^"]+" does not exist/i;
const UNIQUE_CONSTRAINT_PATTERN = /unique constraint|duplicate key/i;
const UNIQUE_CONSTRAINT_EXTRACT =
  /unique constraint "[^"]+"|duplicate key value/i;
const CONNECTION_REFUSED_PATTERN = /connection refused|ECONNREFUSED.*5432/i;
const CONNECTION_REFUSED_EXTRACT = /connection refused[^\n]*/i;
const TYPESCRIPT_ERROR_PATTERN = /Type error:|error TS[0-9]+:/;
const TYPESCRIPT_ERROR_EXTRACT = /error TS[0-9]+:[^\n]+(\n\s+[^\n]+)*/;
const MODULE_NOT_FOUND_PATTERN = /Module not found|Cannot find module/i;
const MODULE_NOT_FOUND_EXTRACT =
  /(?:Module not found|Cannot find module)[^\n]+/i;
const OUT_OF_MEMORY_PATTERN = /ENOMEM|heap out of memory|JavaScript heap/i;
const OUT_OF_MEMORY_EXTRACT =
  /(?:ENOMEM|heap out of memory|JavaScript heap)[^\n]*/i;
const PNPM_ERROR_PATTERN = /ERR_PNPM_|pnpm ERR!/i;
const PNPM_ERROR_EXTRACT = /ERR_PNPM_[A-Z_]+[^\n]*/i;
const MISSING_ENV_PATTERN =
  /missing required.*environment|env.*not set|undefined.*env/i;
const MISSING_ENV_EXTRACT =
  /(?:missing|undefined)[^\n]*(?:env|environment)[^\n]*/i;
const ENV_VALIDATION_PATTERN = /Invalid environment variables/i;
const ENV_VALIDATION_EXTRACT = /Invalid environment variables[\s\S]{0,500}/i;
const FUNCTION_ERROR_PATTERN =
  /FUNCTION_INVOCATION_FAILED|EDGE_FUNCTION_INVOCATION/i;
const FUNCTION_ERROR_EXTRACT =
  /(?:FUNCTION_INVOCATION_FAILED|EDGE_FUNCTION)[^\n]*/i;
const BUILD_TIMEOUT_PATTERN = /Build exceeded maximum duration/i;
const MERGE_CONFLICT_PATTERN = /CONFLICT|merge conflict|cannot merge/i;
const MERGE_CONFLICT_EXTRACT = /(?:CONFLICT|merge conflict)[^\n]*/i;
const NOT_MERGEABLE_PATTERN = /not mergeable|MERGEABLE.*CONFLICTING/i;
const NOT_MERGEABLE_EXTRACT = /(?:not mergeable|MERGEABLE[^\n]*)/i;
const CODE_FENCE_PATTERN = /```/g;

// Error patterns and their diagnoses
const ERROR_PATTERNS = [
  // Prisma / Database errors
  {
    category: "DATABASE",
    pattern: PRISMA_ERROR_PATTERN,
    name: "Prisma Error",
    extract: (log) => log.match(PRISMA_ERROR_EXTRACT)?.[0],
    suggestions: [
      "Check if migrations are up to date: `prisma migrate status`",
      "Verify database connection string in environment",
      "Check for pending migrations that need to be applied",
    ],
  },
  {
    category: "DATABASE",
    pattern: RELATION_MISSING_PATTERN,
    name: "Missing Table/Relation",
    extract: (log) => log.match(RELATION_MISSING_EXTRACT)?.[0],
    suggestions: [
      "Run `prisma migrate deploy` to apply pending migrations",
      "Check if the migration creating this table was committed",
      "Verify you're connecting to the correct database",
    ],
  },
  {
    category: "DATABASE",
    pattern: UNIQUE_CONSTRAINT_PATTERN,
    name: "Unique Constraint Violation",
    extract: (log) => log.match(UNIQUE_CONSTRAINT_EXTRACT)?.[0],
    suggestions: [
      "Check for duplicate data in seed scripts",
      "Verify upsert logic handles existing records",
      "Check if migration is idempotent",
    ],
  },
  {
    category: "DATABASE",
    pattern: CONNECTION_REFUSED_PATTERN,
    name: "Database Connection Failed",
    extract: (log) => log.match(CONNECTION_REFUSED_EXTRACT)?.[0],
    suggestions: [
      "Verify DATABASE_URL is correctly set",
      "Check if database server is running and accessible",
      "Verify network/firewall rules allow connection",
    ],
  },

  // Build errors
  {
    category: "BUILD",
    pattern: TYPESCRIPT_ERROR_PATTERN,
    name: "TypeScript Error",
    extract: (log) => {
      const match = log.match(TYPESCRIPT_ERROR_EXTRACT);
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
    pattern: MODULE_NOT_FOUND_PATTERN,
    name: "Missing Module",
    extract: (log) => log.match(MODULE_NOT_FOUND_EXTRACT)?.[0],
    suggestions: [
      "Run `pnpm install` to ensure dependencies are installed",
      "Check if the import path is correct",
      "Verify the package is in package.json",
    ],
  },
  {
    category: "BUILD",
    pattern: OUT_OF_MEMORY_PATTERN,
    name: "Out of Memory",
    extract: (log) => log.match(OUT_OF_MEMORY_EXTRACT)?.[0],
    suggestions: [
      "Increase Node memory: `NODE_OPTIONS=--max_old_space_size=4096`",
      "Check for memory leaks in build process",
      "Consider splitting large builds",
    ],
  },
  {
    category: "BUILD",
    pattern: PNPM_ERROR_PATTERN,
    name: "pnpm Error",
    extract: (log) => log.match(PNPM_ERROR_EXTRACT)?.[0],
    suggestions: [
      "Try clearing pnpm cache: `pnpm store prune`",
      "Delete node_modules and pnpm-lock.yaml, reinstall",
      "Check for conflicting dependency versions",
    ],
  },

  // Environment errors
  {
    category: "ENVIRONMENT",
    pattern: MISSING_ENV_PATTERN,
    name: "Missing Environment Variable",
    extract: (log) => log.match(MISSING_ENV_EXTRACT)?.[0],
    suggestions: [
      "Check Vercel environment variables are set for production",
      "Verify variable names match exactly (case-sensitive)",
      "Check if .env.local values need to be in Vercel dashboard",
    ],
  },
  {
    category: "ENVIRONMENT",
    pattern: ENV_VALIDATION_PATTERN,
    name: "Environment Validation Failed",
    extract: (log) => {
      const match = log.match(ENV_VALIDATION_EXTRACT);
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
    pattern: FUNCTION_ERROR_PATTERN,
    name: "Serverless Function Error",
    extract: (log) => log.match(FUNCTION_ERROR_EXTRACT)?.[0],
    suggestions: [
      "Check function logs in Vercel dashboard",
      "Verify function doesn't exceed timeout/memory limits",
      "Check for unhandled exceptions in API routes",
    ],
  },
  {
    category: "VERCEL",
    pattern: BUILD_TIMEOUT_PATTERN,
    name: "Build Timeout",
    extract: (_log) => "Build exceeded maximum duration",
    suggestions: [
      "Optimize build by reducing bundle size",
      "Check for infinite loops in build scripts",
      "Consider upgrading Vercel plan for longer builds",
    ],
  },

  // Git/Merge errors
  {
    category: "GIT",
    pattern: MERGE_CONFLICT_PATTERN,
    name: "Merge Conflict",
    extract: (log) => log.match(MERGE_CONFLICT_EXTRACT)?.[0],
    suggestions: [
      "Resolve conflicts locally and push to main",
      "Check if production branch has diverged",
      "Consider rebasing main onto production first",
    ],
  },
  {
    category: "GIT",
    pattern: NOT_MERGEABLE_PATTERN,
    name: "PR Not Mergeable",
    extract: (log) => log.match(NOT_MERGEABLE_EXTRACT)?.[0],
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
        detail:
          pattern.extract(errorLog) ||
          "Pattern matched but no detail extracted",
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

function formatVercelStatus(vercel) {
  if (vercel.skipped) {
    return "  • Vercel: ⊘ Skipped";
  }
  if (vercel.ok) {
    return "  • Vercel: ✓ All deployments ready";
  }
  const failed = vercel.deployments?.filter((d) => d.failed) || [];
  return `  • Vercel: ✗ ${failed.length} deployment(s) failed`;
}

function formatDatabaseStatus(database) {
  if (database.skipped) {
    return "  • Database: ⊘ Skipped";
  }
  if (database.ok) {
    const latency = database.checks?.connectivity?.latencyMs;
    return `  • Database: ✓ Healthy${latency ? ` (${latency}ms)` : ""}`;
  }
  const error = database.checks?.connectivity?.error || "Unknown error";
  return `  • Database: ✗ ${error}`;
}

function formatHealthChecks(healthStatuses) {
  if (!healthStatuses || Object.keys(healthStatuses).length === 0) {
    return [];
  }

  const lines = ["", "*Health Checks:*"];

  if (healthStatuses.vercel) {
    lines.push(formatVercelStatus(healthStatuses.vercel));
  }

  if (healthStatuses.database) {
    lines.push(formatDatabaseStatus(healthStatuses.database));
  }

  return lines;
}

function formatDiagnosisFindings(diagnosis, categoryEmoji) {
  const lines = [];

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

  return lines;
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
    "*Deploy Failed* — requires attention",
    "",
    `• *PR:* ${prUrl || "N/A"}`,
    `• *Branch:* \`${branch || "main"}\` → \`production\``,
    `• *Commit:* \`${sha?.slice(0, 7) || "N/A"}\``,
    `• *Failed Step:* ${step || "Unknown"}`,
    `• *Logs:* ${runUrl}`,
  ];

  lines.push(...formatHealthChecks(healthStatuses));

  lines.push("");
  lines.push("─────────────────────────");
  lines.push("*Diagnosis:*");
  lines.push("");

  lines.push(...formatDiagnosisFindings(diagnosis, categoryEmoji));

  lines.push("─────────────────────────");
  lines.push(
    "_Fix the issue and re-run the deploy workflow, or reply here for help._"
  );

  return lines.join("\n");
}

function chunkForSlack(rawText, maxChunkSize = 2000) {
  // Avoid accidental termination of code fences in Slack
  const text = String(rawText || "").replace(CODE_FENCE_PATTERN, "`` `");
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
    const vercelRaw = await readFile("vercel-status.json", "utf-8").catch(
      () => null
    );
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
