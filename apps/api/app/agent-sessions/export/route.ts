import type { ApiResult } from "@repo/api/src/types/common";
import { NextResponse } from "next/server";
import { withAnyAuth } from "@/lib/auth/with-any-auth";
import { forbiddenResponse, parseQueryParams } from "@/lib/route-utils";
import { getAgentSessionViewerScope } from "../route-helpers";
import { agentSessionsService } from "../service";
import { baseAgentSessionQuerySchema } from "../validators";

const CSV_HEADERS = [
  "Date",
  "User",
  "Team",
  "Project",
  "Harness Type",
  "Model",
  "Session Count",
  "Input Tokens",
  "Output Tokens",
  "Cache Creation Tokens",
  "Cache Read Tokens",
  "Estimated Cost",
] as const;

const CSV_ESCAPED_VALUE_PATTERN = /[",\n]/;
const CSV_FORMULA_PREFIX_PATTERN = /^[=+\-@]/;

function escapeCsvValue(value: string | number): string {
  let text = String(value);
  if (CSV_FORMULA_PREFIX_PATTERN.test(text)) {
    text = `'${text}`;
  }
  if (CSV_ESCAPED_VALUE_PATTERN.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

const SAFE_FILENAME_PATTERN = /[^a-zA-Z0-9\-_]/g;

function buildCsvFilename(orgSlug: string): string {
  const sanitized = orgSlug.replace(SAFE_FILENAME_PATTERN, "");
  const date = new Date().toISOString().slice(0, 10);
  return `agent-sessions-${sanitized || "organization"}-${date}.csv`;
}

export const GET = withAnyAuth<never, "/agent-sessions/export">(
  async ({ user, clerkUserId }, request) => {
    const viewerScope = await getAgentSessionViewerScope({
      userId: user.id,
      clerkUserId,
    });
    if (!viewerScope.monitoringEnabled) {
      return forbiddenResponse();
    }

    const { params: filters, errorResponse } = parseQueryParams(
      request,
      baseAgentSessionQuerySchema
    );
    if (errorResponse) {
      return errorResponse;
    }

    const { rows, orgSlug } = await agentSessionsService.findExportRows({
      organizationId: user.organizationId,
      filters,
    });

    const encoder = new TextEncoder();
    const filename = buildCsvFilename(orgSlug ?? "organization");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${CSV_HEADERS.join(",")}\n`));
        for (const row of rows) {
          const line = [
            row.date,
            row.user,
            row.team,
            row.project,
            row.harnessType,
            row.model,
            row.sessionCount,
            row.inputTokens,
            row.outputTokens,
            row.cacheCreationTokens,
            row.cacheReadTokens,
            row.estimatedCost.toFixed(6),
          ]
            .map(escapeCsvValue)
            .join(",");
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "no-store",
      },
    }) as NextResponse<ApiResult<never>>;
  }
);
