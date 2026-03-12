---
active: true
iteration: 1
max_iterations: 5
prd_file: ""
workdir: "/workspace/repo"
agent_type: "code:plan-writer"
started_at: "2026-03-11T18:03:08Z"
---

Create a comprehensive implementation plan for the requirements in @.

Follow these steps:
1. Read the PRD thoroughly to understand ALL requirements
2. Explore the codebase to understand existing patterns and architecture
3. Write the plan to /workspace/repo/plan.json following the quality criteria
4. After validation feedback, address ALL issues and update /workspace/repo/plan.json

Quality criteria your plan must meet:
- Every PRD requirement has a corresponding task
- Tasks use checkbox format (- [ ] or - [x])
- ## Open Questions section exists (with checkbox format)
- No TODO/TBD placeholders
- Justify any new file creation (prefer extending existing files)
- Avoid code duplication patterns

Output <promise>PLAN_WRITER_COMPLETE</promise> ONLY when validation passes.
