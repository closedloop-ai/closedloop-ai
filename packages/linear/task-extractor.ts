import "server-only";
import { generateObject, models } from "@repo/ai/server";
import { z } from "zod";

/**
 * LLM-based task extraction from implementation plans.
 *
 * Uses Claude to intelligently extract tasks from any markdown format:
 * - Checkbox syntax (- [ ] / - [x])
 * - Regular bullets
 * - Numbered lists
 * - Prose descriptions
 * - Mixed formats
 *
 * Handles variations gracefully without brittle regex patterns.
 */

const TASK_EXTRACTION_INSTRUCTIONS = `You are extracting tasks from an implementation plan document.

Extract ALL tasks regardless of format:
- Checkbox items: - [ ] Task or - [x] Completed task
- Regular bullet points describing work to be done
- Numbered lists of tasks or steps
- Tasks described in prose or paragraphs
- Sub-tasks under main tasks (include all levels)

For each task, determine:
1. **title**: The task summary (keep concise, 1-2 lines max)
2. **description**: Any additional details about the task (optional)
3. **sectionContext**: The section/phase heading this task falls under (e.g., "Backend Implementation", "Phase 1: Foundation")
4. **isCompleted**: true if marked as done/completed (look for [x], ✓, "completed", "done"), false otherwise

If a task has multiple sub-points, you can either:
- Combine them into one task with sub-points in the description
- OR create separate tasks for each sub-point (use your judgment based on granularity)`;

const taskSchema = z.object({
  tasks: z.array(
    z.object({
      title: z.string().describe("The task title or summary"),
      description: z
        .string()
        .optional()
        .describe("Additional task details or context"),
      sectionContext: z
        .string()
        .optional()
        .describe(
          "The section/phase this task belongs to (e.g., 'Backend Implementation', 'Phase 1')"
        ),
      isCompleted: z
        .boolean()
        .describe("Whether the task is marked as completed/done"),
    })
  ),
});

export type ExtractedTask = z.infer<typeof taskSchema>["tasks"][number];

/**
 * Extract tasks from an implementation plan using LLM analysis.
 *
 * @param markdown - The implementation plan markdown content
 * @returns Array of extracted tasks with metadata
 *
 * @throws Error if LLM call fails
 *
 * @example
 * ```typescript
 * const tasks = await extractTasksWithLLM(`
 * ## Phase 1
 * - [ ] Setup database
 * - [x] Create API endpoints
 *
 * ## Phase 2
 * 1. Write tests
 * 2. Deploy to staging
 * `);
 * ```
 */
export async function extractTasksWithLLM(
  markdown: string
): Promise<ExtractedTask[]> {
  const { object } = await generateObject({
    model: models.sonnet,
    schema: taskSchema,
    prompt: `${TASK_EXTRACTION_INSTRUCTIONS}

Implementation Plan:

${markdown}`,
  });

  return object.tasks;
}

/**
 * Format a task for Linear issue creation.
 * Includes section context in the description if available.
 */
export function formatTaskForLinear(task: ExtractedTask): {
  title: string;
  description?: string;
} {
  const descriptionParts: string[] = [];

  if (task.sectionContext) {
    descriptionParts.push(`**Section:** ${task.sectionContext}`);
  }

  if (task.description) {
    descriptionParts.push(task.description);
  }

  return {
    title: task.title,
    description:
      descriptionParts.length > 0 ? descriptionParts.join("\n\n") : undefined,
  };
}
