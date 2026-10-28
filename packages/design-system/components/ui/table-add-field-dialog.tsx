"use client";

import { useId, useState } from "react";
import {
  buildFieldDraft,
  CreateFieldForm,
  ExistingFieldPicker,
  isChoiceType,
  isReferenceType,
  TABLE_CUSTOM_FIELD_TYPES,
  TableCustomFieldTimeFormat,
  TableCustomFieldType,
} from "./table-add-field-dialog-content";
import type {
  TableCustomFieldDraft,
  TableCustomFieldReferenceSource,
  TableExistingCustomFieldOption,
} from "./table-add-field-dialog-content";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "./dialog";

export {
  TABLE_CUSTOM_FIELD_TYPES,
  TableCustomFieldTimeFormat,
  TableCustomFieldType,
} from "./table-add-field-dialog-content";
export type {
  TableCustomFieldDefinition,
  TableCustomFieldDraft,
  TableCustomFieldReferenceSource,
  TableExistingCustomFieldOption,
} from "./table-add-field-dialog-content";

export type TableAddFieldDialogProps = {
  availableFieldTypes?: readonly TableCustomFieldType[];
  existingFields?: readonly TableExistingCustomFieldOption[];
  onCreate: (field: TableCustomFieldDraft) => Promise<void> | void;
  onOpenChange: (open: boolean) => void;
  onSelectExisting?: (fieldId: string) => Promise<void> | void;
  open: boolean;
  referenceSources?: readonly TableCustomFieldReferenceSource[];
};

const TableAddFieldDialogView = {
  Choose: "choose",
  Create: "create",
} as const;
type TableAddFieldDialogView =
  (typeof TableAddFieldDialogView)[keyof typeof TableAddFieldDialogView];

export function TableAddFieldDialog({
  availableFieldTypes = TABLE_CUSTOM_FIELD_TYPES,
  existingFields = [],
  onCreate,
  onOpenChange,
  onSelectExisting,
  open,
  referenceSources = [],
}: Readonly<TableAddFieldDialogProps>) {
  const formId = useId();
  const hasExistingFieldPicker = onSelectExisting !== undefined;
  const [view, setView] = useState<TableAddFieldDialogView>(() =>
    hasExistingFieldPicker
      ? TableAddFieldDialogView.Choose
      : TableAddFieldDialogView.Create
  );
  const [title, setTitle] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [type, setType] = useState<TableCustomFieldType>(
    availableFieldTypes[0] ?? TableCustomFieldType.SingleSelect
  );
  const [options, setOptions] = useState(["", ""]);
  const [optionColorIndexes, setOptionColorIndexes] = useState([0, 1]);
  const [source, setSource] = useState("");
  const [timeFormat, setTimeFormat] = useState<TableCustomFieldTimeFormat>(
    TableCustomFieldTimeFormat.Duration
  );
  const [isCreating, setIsCreating] = useState(false);
  const [selectingFieldId, setSelectingFieldId] = useState<string | null>(
    null
  );
  const [submitError, setSubmitError] = useState<string | null>(null);
  const canCreate =
    title.trim().length > 0 &&
    (!isChoiceType(type) || options.some((option) => option.trim())) &&
    (!isReferenceType(type) || source.length > 0) &&
    !isCreating;

  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSubmitError(null);
      setSelectingFieldId(null);
      setView(
        hasExistingFieldPicker
          ? TableAddFieldDialogView.Choose
          : TableAddFieldDialogView.Create
      );
    }
    onOpenChange(nextOpen);
  };

  const selectExistingField = async (fieldId: string) => {
    if (!onSelectExisting || selectingFieldId) {
      return;
    }
    setSelectingFieldId(fieldId);
    setSubmitError(null);
    try {
      await onSelectExisting(fieldId);
      changeOpen(false);
    } catch {
      setSubmitError("Couldn't add field. Try again.");
    } finally {
      setSelectingFieldId(null);
    }
  };

  const createField = async () => {
    if (!canCreate) {
      return;
    }
    const draft = buildFieldDraft({
      description,
      optionColorIndexes,
      options,
      source,
      timeFormat,
      title,
      type,
    });
    setIsCreating(true);
    setSubmitError(null);
    try {
      await onCreate(draft);
      resetForm({
        availableFieldTypes,
        setDescription,
        setDescriptionOpen,
        setOptionColorIndexes,
        setOptions,
        setSource,
        setTimeFormat,
        setTitle,
        setType,
      });
      changeOpen(false);
    } catch {
      setSubmitError("Couldn't create field. Try again.");
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogContent
        className={
          view === TableAddFieldDialogView.Choose
            ? "flex max-h-[92vh] w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
            : "flex max-h-[92vh] w-[calc(100vw-32px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
        }
      >
        <DialogHeader className="shrink-0 border-b px-6 py-5">
          <DialogTitle>Add field</DialogTitle>
          <DialogDescription className="sr-only">
            {view === TableAddFieldDialogView.Choose
              ? "Choose an existing field or create one for this table."
              : "Configure a field for this table."}
          </DialogDescription>
        </DialogHeader>

        {view === TableAddFieldDialogView.Choose && onSelectExisting ? (
          <ExistingFieldPicker
            error={submitError}
            fields={existingFields}
            onCreate={() => {
              setSubmitError(null);
              setView(TableAddFieldDialogView.Create);
            }}
            onSelect={selectExistingField}
            selectingFieldId={selectingFieldId}
          />
        ) : (
          <CreateFieldForm
            availableFieldTypes={availableFieldTypes}
            canCreate={canCreate}
            description={description}
            descriptionOpen={descriptionOpen}
            formId={formId}
            hasExistingFieldPicker={hasExistingFieldPicker}
            isCreating={isCreating}
            onBack={() => {
              setSubmitError(null);
              setView(TableAddFieldDialogView.Choose);
            }}
            onCancel={() => changeOpen(false)}
            onCreate={createField}
            optionColorIndexes={optionColorIndexes}
            options={options}
            referenceSources={referenceSources}
            setDescription={setDescription}
            setDescriptionOpen={setDescriptionOpen}
            setOptionColorIndexes={setOptionColorIndexes}
            setOptions={setOptions}
            setSource={setSource}
            setSubmitError={setSubmitError}
            setTimeFormat={setTimeFormat}
            setTitle={setTitle}
            setType={setType}
            source={source}
            submitError={submitError}
            timeFormat={timeFormat}
            title={title}
            type={type}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function resetForm({
  availableFieldTypes,
  setDescription,
  setDescriptionOpen,
  setOptionColorIndexes,
  setOptions,
  setSource,
  setTimeFormat,
  setTitle,
  setType,
}: {
  availableFieldTypes: readonly TableCustomFieldType[];
  setDescription: (value: string) => void;
  setDescriptionOpen: (value: boolean) => void;
  setOptionColorIndexes: (value: number[]) => void;
  setOptions: (value: string[]) => void;
  setSource: (value: string) => void;
  setTimeFormat: (value: TableCustomFieldTimeFormat) => void;
  setTitle: (value: string) => void;
  setType: (value: TableCustomFieldType) => void;
}) {
  setTitle("");
  setDescription("");
  setDescriptionOpen(false);
  setType(availableFieldTypes[0] ?? TableCustomFieldType.SingleSelect);
  setOptions(["", ""]);
  setOptionColorIndexes([0, 1]);
  setSource("");
  setTimeFormat(TableCustomFieldTimeFormat.Duration);
}
