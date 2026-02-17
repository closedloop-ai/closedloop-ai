import { generateText, models } from "@repo/ai/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { artifactVersionService } from "@/app/artifacts/artifact-version-service";
import { artifactsService } from "@/app/artifacts/service";
import { withAuth } from "@/lib/auth/with-auth";
import { errorResponse, notFoundResponse, parseBody } from "@/lib/route-utils";

const PRD_INLINE_INSTRUCTIONS = `You are an expert product manager that creates comprehensive Product Requirements Documents (PRDs).

Given the user's input (which may be a rough description, notes, or partial draft), produce a complete, well-structured PRD in markdown format.

Include these sections as appropriate:
- Executive Summary
- Problem Statement
- Goals & Success Metrics
- User Stories & Requirements
- Scope (In/Out of Scope)
- Technical Considerations
- Dependencies & Risks
- Timeline & Milestones

Guidelines:
- Assume reasonable defaults for any missing details. Document assumptions as open questions at the end.
- Do NOT ask clarifying questions — produce the best PRD you can from the available input.
- Use clear, professional language appropriate for a cross-functional audience.
- If the input references a URL or external source, incorporate that context into the PRD.
- Output only the PRD content in markdown. Do not include preamble or commentary.`;

const bodySchema = z.object({
  artifactId: z.string().min(1),
  reverseSynthesisLink: z.string().url().optional(),
});

export const POST = withAuth<
  { artifactId: string; content: string },
  "/ai/prd/generate"
>(async ({ user }, request) => {
  try {
    const { body, errorResponse: parseError } = await parseBody(
      request,
      bodySchema
    );
    if (parseError) {
      return parseError;
    }

    const { artifactId, reverseSynthesisLink } = body;

    // Verify artifact exists and belongs to org
    const artifact = await artifactsService.findByIdSimple(
      artifactId,
      user.organizationId
    );
    if (!artifact) {
      return notFoundResponse("Artifact");
    }

    // Get latest version content as input context
    const latestVersion = await artifactVersionService.getLatest(artifactId);
    const sourceContent = latestVersion?.content ?? "";

    // Build prompt context (reuses existing PRD context builder)
    const prompt = artifactsService.buildPRDContext(
      sourceContent,
      null,
      reverseSynthesisLink ?? null
    );

    // Generate PRD content inline using Sonnet
    const result = await generateText({
      model: models.sonnet,
      system: PRD_INLINE_INSTRUCTIONS,
      prompt,
    });

    // Save generated content as a new version
    await artifactsService.createNewVersion(
      artifactId,
      user.organizationId,
      user.id,
      result.text
    );

    return NextResponse.json({
      success: true,
      data: { artifactId, content: result.text },
    });
  } catch (error) {
    return errorResponse("Failed to generate PRD", error);
  }
});
