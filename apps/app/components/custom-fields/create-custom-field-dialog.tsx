"use client";

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema";
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldWithOptions,
  LabelPosition,
  NumberFormat,
} from "@repo/api/src/types/custom-field";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@repo/design-system/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@repo/design-system/components/ui/form";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Textarea } from "@repo/design-system/components/ui/textarea";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import z from "zod";
import {
  useCreateCustomField,
  useUpdateCustomField,
} from "@/hooks/queries/use-custom-fields";
import { ENTITY_TYPE_LABELS, FIELD_TYPE_LABELS } from "./constants";
import { EnumOptionBuilder } from "./enum-option-builder";
import { NumberFormatConfig } from "./number-format-config";

const formSchema = z.object({
  name: z.string().min(1, { message: "Name is required" }),
  description: z.string().optional(),
  fieldType: z.enum(CustomFieldType),
  // Number-specific fields
  numberFormat: z.enum(NumberFormat).optional(),
  precision: z.number().optional(),
  currencyCode: z.string().optional(),
  customLabel: z.string().optional(),
  customLabelPosition: z.enum(LabelPosition).optional(),
  // Enum options (create mode only)
  enumOptions: z
    .array(
      z.object({
        name: z.string(),
        color: z.string().optional(),
        enabled: z.boolean().optional(),
        sortOrder: z.number().optional(),
      })
    )
    .optional(),
  // Entity types this field applies to
  entityTypes: z.array(z.enum(CustomFieldEntityType)),
  // Display configuration
  showInTable: z.boolean(),
  isSearchable: z.boolean(),
  isSortable: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

export type CreateCustomFieldDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  field?: CustomFieldWithOptions;
};

function getSubmitLabel(isPending: boolean, isEditMode: boolean): string {
  if (isPending) {
    return isEditMode ? "Saving..." : "Creating...";
  }
  return isEditMode ? "Save Changes" : "Create Field";
}

export function CreateCustomFieldDialog({
  open,
  onOpenChange,
  field,
}: Readonly<CreateCustomFieldDialogProps>) {
  const isEditMode = Boolean(field);
  const createCustomField = useCreateCustomField();
  const updateCustomField = useUpdateCustomField();

  const form = useForm<FormValues>({
    resolver: standardSchemaResolver(formSchema),
    defaultValues: {
      name: "",
      description: "",
      fieldType: CustomFieldType.Text,
      numberFormat: NumberFormat.None,
      precision: 0,
      currencyCode: "",
      customLabel: "",
      customLabelPosition: LabelPosition.Prefix,
      enumOptions: [],
      entityTypes: [],
      showInTable: false,
      isSearchable: false,
      isSortable: false,
    },
  });

  // Pre-fill form with existing field data in edit mode, or reset on open/close
  useEffect(() => {
    if (open && field) {
      form.reset({
        name: field.name,
        description: field.description ?? "",
        fieldType: field.fieldType,
        numberFormat: field.numberFormat ?? NumberFormat.None,
        precision: field.precision ?? 0,
        currencyCode: field.currencyCode ?? "",
        customLabel: field.customLabel ?? "",
        customLabelPosition: field.customLabelPosition ?? LabelPosition.Prefix,
        enumOptions: [],
        entityTypes: field.entityTypes ?? [],
        showInTable: field.showInTable ?? false,
        isSearchable: field.isSearchable ?? false,
        isSortable: field.isSortable ?? false,
      });
    } else if (open) {
      form.reset({
        name: "",
        description: "",
        fieldType: CustomFieldType.Text,
        numberFormat: NumberFormat.None,
        precision: 0,
        currencyCode: "",
        customLabel: "",
        customLabelPosition: LabelPosition.Prefix,
        enumOptions: [],
        entityTypes: [],
        showInTable: false,
        isSearchable: false,
        isSortable: false,
      });
    }
  }, [open, field, form]);

  const fieldType = form.watch("fieldType");
  const isNumberType = fieldType === CustomFieldType.Number;
  const isEnumType =
    fieldType === CustomFieldType.Enum ||
    fieldType === CustomFieldType.MultiEnum;

  const isPending = createCustomField.isPending || updateCustomField.isPending;

  const onSubmit = async (values: FormValues) => {
    if (isEditMode && field) {
      await updateCustomField.mutateAsync(
        buildUpdatePayload(field.id, values, isNumberType)
      );
    } else {
      await createCustomField.mutateAsync(
        buildCreatePayload(values, isNumberType, isEnumType)
      );
    }
    onOpenChange(false);
  };

  const title = isEditMode ? "Edit Custom Field" : "Create Custom Field";
  const submitLabel = getSubmitLabel(isPending, isEditMode);

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form className="space-y-4" onSubmit={form.handleSubmit(onSubmit)}>
            <FormField
              control={form.control}
              name="name"
              render={({ field: formField }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="e.g. Priority" {...formField} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="description"
              render={({ field: formField }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Optional description"
                      rows={2}
                      {...formField}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="fieldType"
              render={({ field: formField }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select
                    disabled={isEditMode}
                    onValueChange={formField.onChange}
                    value={formField.value}
                  >
                    <FormControl>
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Select field type" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {Object.values(CustomFieldType).map((type) => (
                        <SelectItem key={type} value={type}>
                          {FIELD_TYPE_LABELS[type]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            {isNumberType && <NumberFormatConfig control={form.control} />}

            {isEnumType && (
              <div className="space-y-2">
                <Label>Options</Label>
                {isEditMode && field ? (
                  <EnumOptionBuilder fieldId={field.id} />
                ) : (
                  <FormField
                    control={form.control}
                    name="enumOptions"
                    render={({ field: formField }) => (
                      <EnumOptionBuilder
                        onChange={formField.onChange}
                        value={formField.value ?? []}
                      />
                    )}
                  />
                )}
              </div>
            )}

            <EntityTypeSelector control={form.control} />

            <DisplayConfigSection control={form.control} />

            <DialogFooter>
              <Button
                onClick={() => onOpenChange(false)}
                type="button"
                variant="outline"
              >
                Cancel
              </Button>
              <Button disabled={isPending} type="submit">
                {submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Entity type selector sub-component
// ---------------------------------------------------------------------------

function EntityTypeSelector({
  control,
}: {
  control: ReturnType<typeof useForm<FormValues>>["control"];
}) {
  return (
    <FormField
      control={control}
      name="entityTypes"
      render={({ field: formField }) => (
        <FormItem>
          <FormLabel>Applies To</FormLabel>
          <div className="flex flex-col gap-2">
            {Object.values(CustomFieldEntityType).map((entityType) => {
              const checked = (formField.value ?? []).includes(entityType);
              return (
                <div
                  className="flex items-center gap-2 text-sm"
                  key={entityType}
                >
                  <Switch
                    checked={checked}
                    onCheckedChange={(on) => {
                      const current = formField.value ?? [];
                      if (on) {
                        formField.onChange([...current, entityType]);
                      } else {
                        formField.onChange(
                          current.filter((t: string) => t !== entityType)
                        );
                      }
                    }}
                  />
                  {ENTITY_TYPE_LABELS[entityType]}
                </div>
              );
            })}
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Display configuration sub-component
// ---------------------------------------------------------------------------

function DisplayConfigSection({
  control,
}: {
  control: ReturnType<typeof useForm<FormValues>>["control"];
}) {
  return (
    <div className="space-y-3">
      <Label>Display Options</Label>
      <FormField
        control={control}
        name="showInTable"
        render={({ field: formField }) => (
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={formField.value}
              onCheckedChange={formField.onChange}
            />
            Show in table views
          </div>
        )}
      />
      <FormField
        control={control}
        name="isSearchable"
        render={({ field: formField }) => (
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={formField.value}
              onCheckedChange={formField.onChange}
            />
            Searchable
          </div>
        )}
      />
      <FormField
        control={control}
        name="isSortable"
        render={({ field: formField }) => (
          <div className="flex items-center gap-2 text-sm">
            <Switch
              checked={formField.value}
              onCheckedChange={formField.onChange}
            />
            Sortable
          </div>
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function buildCreatePayload(
  values: FormValues,
  isNumberType: boolean,
  isEnumType: boolean
) {
  const isCurrency =
    isNumberType && values.numberFormat === NumberFormat.Currency;
  const isCustomLabel =
    isNumberType && values.numberFormat === NumberFormat.Custom;

  return {
    name: values.name,
    description: values.description || undefined,
    fieldType: values.fieldType,
    numberFormat: isNumberType ? values.numberFormat : undefined,
    precision: isNumberType ? values.precision : undefined,
    currencyCode: isCurrency ? values.currencyCode : undefined,
    customLabel: isCustomLabel ? values.customLabel : undefined,
    customLabelPosition: isCustomLabel ? values.customLabelPosition : undefined,
    enumOptions: isEnumType ? values.enumOptions : undefined,
    entityTypes: values.entityTypes,
    showInTable: values.showInTable,
    isSearchable: values.isSearchable,
    isSortable: values.isSortable,
  };
}

function buildUpdatePayload(
  fieldId: string,
  values: FormValues,
  isNumberType: boolean
) {
  const isCurrency =
    isNumberType && values.numberFormat === NumberFormat.Currency;
  const isCustomLabel =
    isNumberType && values.numberFormat === NumberFormat.Custom;

  return {
    id: fieldId,
    name: values.name,
    description: values.description || undefined,
    numberFormat: isNumberType ? values.numberFormat : undefined,
    precision: isNumberType ? values.precision : undefined,
    currencyCode: isCurrency ? values.currencyCode : undefined,
    customLabel: isCustomLabel ? values.customLabel : undefined,
    customLabelPosition: isCustomLabel ? values.customLabelPosition : undefined,
    entityTypes: values.entityTypes,
    showInTable: values.showInTable,
    isSearchable: values.isSearchable,
    isSortable: values.isSortable,
  };
}
