# Implementation Plan: Implementation Plan Title Editable

## Summary

**Objective:** Enable users to edit the title of an implementation plan before creating it in the "Generate Implementation Plan" modal dialog. Currently, the title defaults to `Implementation Plan: {PRD Title}` and cannot be changed.

**In-scope:**
- Add title and filename input fields to the new plan modal
- Pre-populate title with computed default (`Implementation Plan: {PRD Title}`)
- Pre-populate filename with auto-generated default from PRD
- Allow users to edit both fields before submission
- Auto-generate filename from title changes (user can override)
- Validate title is not empty before submission
- Update preview to show editable title and filename

**Out-of-scope:**
- Backend API changes (API already accepts custom titles)
- Changes to existing implementation plans
- Bulk title editing

**Platforms:** Web

**Dependencies:** None (uses existing UI components from `@repo/design-system`)

## Architecture Fit

**Impacted components:**
- `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx` - Add title/filename state and input fields

**State changes:**
- Add `title` and `fileName` to component state
- Initialize with computed defaults from selected PRD

**Integrations:**
- None - purely frontend UI enhancement

**Next.js notes:**
- Client component (already marked with `"use client"`)
- No SSR concerns

## Tasks (Traceable)

| Req ID | Task ID | Task Title | Owner | Files/Modules | Complexity (S/M/L) | Platform(s) |
| -----: | ------- | ---------- | ----- | ------------- | ------------------ | ----------- |
| AC-001 | task-001 | Add title and filename state to NewPlanModal | Eng | `new-plan-modal.tsx` | S | Web |
| AC-002 | task-002 | Add title input field to modal form | Eng | `new-plan-modal.tsx` | S | Web |
| AC-003 | task-003 | Add filename input field to modal form | Eng | `new-plan-modal.tsx` | S | Web |
| AC-003 | task-004 | Update PlanPreview to display editable title and filename | Eng | `new-plan-modal.tsx` | S | Web |
| AC-004 | task-005 | Update form submission to use state values | Eng | `new-plan-modal.tsx` | S | Web |
| AC-006 | task-006 | Add form validation for empty title | Eng | `new-plan-modal.tsx` | S | Web |

### task-001: Add title and filename state to NewPlanModal

**Files:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx`
**Complexity:** S
**AC Refs:** AC-001, AC-005

**Description:** Add state variables for `title` and `fileName` with computed defaults, and implement `handleTitleChange` to auto-generate filename from title changes.

**Implementation Details:**

**State initialization:** Initialize state from sourcePrd to avoid empty state flashes:

```tsx
const [title, setTitle] = useState(() =>
  sourcePrd ? `Implementation Plan: ${sourcePrd.title}` : ""
);
const [fileName, setFileName] = useState(() =>
  sourcePrd ? generatePlanFileName(sourcePrd) : ""
);
```

**Handler function:** Add handler with explicit type annotation and edge case handling:

```tsx
const handleTitleChange = (value: string): void => {
  setTitle(value);
  // Auto-generate filename from custom title (simpler pattern than PRD-based generation)
  // This allows users to get clean filenames from any title, not just PRD-formatted ones
  if (value.trim()) {
    const generatedFileName = value
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .replace(/\s+/g, "-")
      .concat("-impl-plan.md");
    setFileName(generatedFileName);
  } else {
    // Reset filename when title is cleared
    setFileName("");
  }
};
```

**Initialization logic:** Update the useEffect to handle when sourcePrd is selected from dropdown:

```tsx
useEffect(() => {
  if (selectedPrd && !sourcePrd) {
    setTitle(`Implementation Plan: ${selectedPrd.title}`);
    setFileName(generatePlanFileName(selectedPrd));
  }
}, [selectedPrd, sourcePrd]);
```

This prevents empty state flashes and clarifies the two initialization paths: (1) from sourcePrd prop on mount, (2) from dropdown selection during interaction.

**Update resetForm():** (lines 143-147)

```tsx
const resetForm = () => {
  setSelectedPrdId(sourcePrd?.id ?? "");
  setTitle("");           // NEW
  setFileName("");        // NEW
  setContent("");
  setError(null);
};
```

---

### task-002: Add title input field to modal form

**Files:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx`
**Complexity:** S
**AC Refs:** AC-002

**Description:** Add an Input field for title editing, placed before the Source PRD selector.

**Implementation Details:**

**Step 1: Add import statement** - Add to existing design-system import block (lines 4-14), maintaining alphabetical ordering:

```tsx
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@repo/design-system/components/ui/dialog";
import { Input } from "@repo/design-system/components/ui/input";  // Add here
import { Label } from "@repo/design-system/components/ui/label";
```

This follows API-first ordering: keep imports from the same package grouped together.

**Step 2: Add input field** at line 226 (before the Source PRD selector section)

**Code to add:**

```tsx
<div className="space-y-2">
  <Label htmlFor="new-title">
    Title<span className="text-destructive">*</span>
  </Label>
  <Input
    id="new-title"
    onChange={(e) => handleTitleChange(e.target.value)}
    placeholder="Implementation Plan: Dashboard Redesign"
    value={title}
    aria-invalid={error ? "true" : "false"}
    aria-describedby={error ? "title-error" : undefined}
  />
</div>
```

**Accessibility enhancement:** The input includes `aria-invalid` for validation feedback states to improve screen reader announcements when validation errors occur. This follows the pattern used in the design system's Input component (line 13 of input.tsx), which has built-in support for aria-invalid styling.

**UX consistency improvement:** Using a concrete example placeholder ("Dashboard Redesign") instead of a template pattern ("Implementation Plan: {PRD Title}") matches the PRD modal's approach (line 137 of new-prd-modal.tsx) and provides clearer guidance about expected input format.

---

### task-003: Add filename input field to modal form

**Files:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx`
**Complexity:** S
**AC Refs:** AC-005

**Description:** Add an Input field for filename editing, placed after the title input field.

**Implementation Details:**

**Location:** Insert after the title input field (after task-002 addition)

**Code to add:**

```tsx
<div className="space-y-2">
  <Label htmlFor="new-filename">File name</Label>
  <Input
    id="new-filename"
    onChange={(e) => setFileName(e.target.value)}
    placeholder={fileName || "dashboard-redesign-impl-plan.md"}
    value={fileName}
  />
</div>
```

**Note:** `Input` component is imported in task-002

**UX clarity improvement:** The placeholder shows the actual generated pattern (using the fileName state value as the placeholder, with a concrete example fallback) to make it clearer to users what the auto-generated filename will look like.

---

### task-004: Update PlanPreview to display editable title and filename

**Files:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx`
**Complexity:** S
**AC Refs:** AC-003

**Description:** Modify the PlanPreview component to accept and display the editable title and filename from state. The component should always show the current state value, not a fallback.

**Implementation Details:**

**Current code (lines 83-101):**

```tsx
function PlanPreview({ prd }: { prd: ArtifactWithWorkstream }) {
  return (
    <div className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="mb-1 font-medium">Plan will be created with:</p>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Title:</span>{" "}
          Implementation Plan: {prd.title}
        </li>
        {prd.approver ? (
          <li>
            <span className="font-medium text-foreground">Approver:</span>{" "}
            {prd.approver}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
```

**Updated code:**

```tsx
function PlanPreview({
  prd,
  title,
  fileName
}: {
  prd: ArtifactWithWorkstream;
  title: string;
  fileName: string;
}) {
  return (
    <div className="rounded-md border bg-muted/50 p-3 text-sm">
      <p className="mb-1 font-medium">Plan will be created with:</p>
      <ul className="space-y-1 text-muted-foreground">
        <li>
          <span className="font-medium text-foreground">Title:</span>{" "}
          {title || <span className="italic text-muted-foreground">No title entered</span>}
        </li>
        <li>
          <span className="font-medium text-foreground">File name:</span>{" "}
          {fileName || <span className="italic text-muted-foreground">Auto-generated</span>}
        </li>
        {prd.approver ? (
          <li>
            <span className="font-medium text-foreground">Approver:</span>{" "}
            {prd.approver}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
```

**Update usage (line 244):**

```tsx
{selectedPrd ? <PlanPreview prd={selectedPrd} title={title} fileName={fileName} /> : null}
```

**Rationale for changes:**
1. Always display current state (title/fileName from form inputs)
2. Show helpful placeholder text when fields are empty instead of misleading fallbacks
3. Include fileName in preview so users can see auto-generation working
4. Remove fallback pattern that could show stale/incorrect data

---

### task-005: Update form submission to use state values

**Files:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx`
**Complexity:** S
**AC Refs:** AC-004

**Description:** Replace the hardcoded title and filename in the `handleSubmit` function with values from state.

**Implementation Details:**

**Current code (lines 160-163):**

```tsx
const result = await createAndGeneratePlan({
  type: "IMPLEMENTATION_PLAN",
  title: `Implementation Plan: ${selectedPrd.title}`,
  fileName: generatePlanFileName(selectedPrd),
  // ...
});
```

**Updated code:**

```tsx
const result = await createAndGeneratePlan({
  type: "IMPLEMENTATION_PLAN",
  title: title.trim(),
  fileName: fileName.trim() || generatePlanFileName(selectedPrd),
  // ...
});
```

**Changes:**
- `title` uses `title.trim()` from state
- `fileName` uses `fileName.trim()` from state, with fallback to computed value if empty

**UX Consistency Note:** The fallback filename generation in handleSubmit provides good UX (auto-generate if user clears the filename), ensuring the form always submits with a valid filename.

---

### task-006: Add form validation for empty title

**Files:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.tsx`
**Complexity:** S
**AC Refs:** AC-006

**Description:** Add validation to prevent submission when title is empty. Use button disabled state as the primary validation mechanism to match existing component patterns.

**Implementation Details:**

**Update submit button disabled state (line 267):**

```tsx
<Button
  disabled={isPending || !selectedPrd || !title.trim()}
  onClick={handleSubmit}
>
```

**Add defensive validation in handleSubmit():** While the button disabled state prevents submission when title is empty, add defensive validation to handle edge cases:

```tsx
if (!selectedPrd) {
  setError("Please select a source PRD");
  return;
}

if (!title.trim()) {
  setError("Please enter a title");
  return;
}

// Additional safety: Verify state is initialized (defensive programming)
// This catches edge cases where useEffect hasn't run yet
if (!fileName && selectedPrd) {
  // Auto-initialize if somehow missed
  const generatedFileName = generatePlanFileName(selectedPrd);
  setFileName(generatedFileName);
}
```

**Update error display:** Associate the error message with the title input using aria-describedby:

```tsx
// Update error display to include ID
{error ? (
  <div
    id="title-error"
    className="rounded-md border border-destructive/20 bg-destructive/10 p-3 text-destructive text-sm"
    role="alert"
  >
    {error}
  </div>
) : null}
```

**Rationale:**
- Button disabled state provides immediate visual feedback
- Prevents users from clicking submit with invalid data
- Defensive validation catches race conditions where state may not be initialized yet
- Error message association follows WCAG 3.3.1 (Error Identification) guidelines
- Ensures form submission reliability even in edge cases

## API & Data Models

**No changes required.**

The existing API endpoint (`apps/api/app/api/artifacts`) and type definitions (`packages/api/src/types/artifact.ts`) already support custom `title` and `fileName` fields:

```typescript
// CreateArtifactInput (artifact.ts:88-103)
{
  title: string;        // Required - already accepts custom values
  fileName?: string;    // Optional
  // ... other fields
}
```

The frontend currently passes computed values, but the backend accepts any string.

## UX/UI Implementation

### Components to create/change

**1. NewPlanModal component** (`new-plan-modal.tsx`)

**Changes:**
- Add title input field before PRD selector
- Add filename input field after title
- Update PlanPreview to show editable title and filename from state
- Wire inputs to state with auto-generation logic

**Component structure (after changes):**
```
DialogContent
├── DialogHeader
├── Error display (if any)
├── Title input field (NEW)
├── Filename input field (NEW)
├── Source PRD selector (existing)
├── PlanPreview (updated to use state.title and state.fileName)
└── Initial Content textarea (existing)
```

### Accessibility

- Label elements associated with input fields via `htmlFor`
- Required indicator (`*`) on title field
- Error messages tied to form validation with `aria-describedby` and `aria-invalid`
- Error display includes `role="alert"` for screen reader announcements
- Tab order varies based on context:
  - **Without sourcePrd:** Title → Filename → PRD Select → Content → Cancel → Generate Plan
  - **With sourcePrd:** Title → Filename → Content → Cancel → Generate Plan

When sourcePrd is provided, the PRD field renders as a static div (lines 230-233 of new-plan-modal.tsx) and is not focusable, so it's skipped in the tab order.

### Responsive behaviors

- Input fields use existing responsive patterns from design system
- Modal scrolls on small viewports (already handled)

## Tests

### Unit tests

**File:** `apps/app/app/(authenticated)/implementation-plans/components/new-plan-modal.test.tsx` (new)

**Test cases:**
1. Renders with default title pre-populated from PRD
2. Renders with default filename pre-populated from PRD
3. Updates title state when user types in title input
4. Auto-generates filename when title changes
5. Allows filename to be manually overridden
6. Shows validation error when title is empty
7. Disables submit button when title is empty
8. Preview displays current title and filename from state (not computed)
9. Calls createAndGeneratePlan with custom title/filename on submit
10. Resets title/filename when modal closes

### Type Safety Tests

**Purpose:** Ensure TypeScript type checking succeeds and runtime types are correct.

**Test cases:**

1. **Type compilation test**: Verify `pnpm typecheck` passes after changes
2. **State type safety**: Verify title and fileName are typed as `string` (not `string | undefined`)
3. **Handler type safety**: Verify handleTitleChange accepts string parameter
4. **PlanPreview props**: Verify title and fileName props are correctly typed as `string`
5. **Input component compatibility**: Verify Input onChange handler receives correct event type

**Implementation:**

```tsx
// In new-plan-modal.test.tsx
describe('Type Safety', () => {
  it('initializes title and fileName as empty strings', () => {
    const { container } = render(<NewPlanModal />);
    const titleInput = container.querySelector('#new-title') as HTMLInputElement;
    const fileNameInput = container.querySelector('#new-filename') as HTMLInputElement;

    // Both should be empty strings, not undefined
    expect(titleInput.value).toBe('');
    expect(fileNameInput.value).toBe('');
  });

  it('maintains string type for title after changes', async () => {
    const { container } = render(<NewPlanModal />);
    const titleInput = container.querySelector('#new-title') as HTMLInputElement;

    fireEvent.change(titleInput, { target: { value: 'New Title' } });
    expect(typeof titleInput.value).toBe('string');
    expect(titleInput.value).toBe('New Title');
  });
});
```

**CI/CD Integration:**
- Add explicit `pnpm typecheck` step after component changes
- Ensure TypeScript strict mode passes with no errors
- Verify no `any` types introduced in the implementation

### Integration tests

Not required - this is a self-contained UI change.

### E2E tests

**File:** `apps/app/e2e/implementation-plans/new-plan-modal.spec.ts` (new or add to existing)

**Test cases:**
1. Create plan with default title and filename
2. Create plan with custom title and auto-generated filename
3. Create plan with custom title and custom filename
4. Verify created plan has correct title in database

### Coverage targets

- 90%+ line coverage for new-plan-modal.tsx
- All user interaction paths covered

### Fixtures/mocks

- Mock PRD artifact with known title
- Mock `createAndGeneratePlan` action
- Mock router.push

## Telemetry & Observability

### Analytics events

**Event:** `implementation_plan_created`

**Existing props:**
- `prd_id` - source PRD ID
- `has_initial_content` - boolean

**New props to add:**
- `title_edited` - boolean (true if user changed default title)
- `filename_edited` - boolean (true if user changed default filename)

**Trigger:** On successful plan creation in `handleSubmit()`

### Error boundaries

- Existing error handling in modal (display error state)
- No new error boundaries needed

### Logging

- Log title/filename validation failures (client-side console)

## Performance & Security

### Performance risks

**None.** Changes are minimal UI updates with no performance impact.

### Security/Privacy risks

**None.** Title and filename are user-controlled inputs already validated by the backend. No new security concerns introduced.

## Release & Ops

### Feature flags

Not required - this is a straightforward UI enhancement.

### Build/CI/CD updates

None required.

### Docs to update

- Product docs: Update "Creating Implementation Plans" section to mention editable title/filename
- User guide: Add screenshot showing new input fields

## Risks / Open Questions

**None.** Implementation is straightforward and follows existing patterns from the PRD modal.

## Traceability

### Acceptance Criteria

**AC-001:** Modal displays a default title computed from PRD
- **Task:** task-001 (Add title state)
- **Validation:** Unit test: "Renders with default title pre-populated from PRD"

**AC-002:** User can edit the title before creating the plan
- **Task:** task-002 (Add title input field)
- **Validation:** Unit test: "Updates title state when user types in title input"

**AC-003:** Title changes are reflected in the preview
- **Task:** task-004 (Update PlanPreview)
- **Validation:** Unit test: "Preview displays current title from state"

**AC-004:** Edited title is saved when plan is created
- **Task:** task-005 (Update form submission)
- **Validation:** E2E test: "Create plan with custom title and verify in database"

**AC-005:** Filename is auto-generated from title (editable)
- **Task:** task-001, task-003 (Add state and filename input)
- **Validation:** Unit test: "Auto-generates filename when title changes"

**AC-006:** Validation ensures title is not empty
- **Task:** task-006 (Add validation)
- **Validation:** Unit test: "Shows validation error when title is empty"
