"use client";

import type { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@repo/design-system/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@repo/design-system/components/ui/popover";
import { PlusIcon } from "lucide-react";
import { useState } from "react";
import {
  useAttachCustomField,
  useCustomFieldSettings,
  useCustomFields,
} from "@/hooks/queries/use-custom-fields";
import { FIELD_TYPE_LABELS } from "./constants";
import { CreateCustomFieldDialog } from "./create-custom-field-dialog";

type AddFieldPopoverProps = {
  entityType: CustomFieldEntityType;
  entityId: string;
};

export function AddFieldPopover({
  entityType,
  entityId,
}: Readonly<AddFieldPopoverProps>) {
  const [open, setOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  const { data: allFields = [] } = useCustomFields();
  const { data: settings = [] } = useCustomFieldSettings(entityType, entityId);
  const attachCustomField = useAttachCustomField(entityType, entityId);

  const attachedFieldIds = new Set(settings.map((s) => s.customFieldId));
  const availableFields = allFields.filter((f) => !attachedFieldIds.has(f.id));

  const handleSelect = async (fieldId: string) => {
    setOpen(false);
    await attachCustomField.mutateAsync({ customFieldId: fieldId });
  };

  const handleCreateNew = () => {
    setOpen(false);
    setCreateDialogOpen(true);
  };

  return (
    <>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button size="sm" variant="ghost">
            <PlusIcon className="h-4 w-4" />
            Add Field
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search fields..." />
            <CommandList>
              <CommandEmpty>No fields found.</CommandEmpty>
              <CommandGroup>
                {availableFields.map((field) => (
                  <CommandItem
                    key={field.id}
                    onSelect={() => handleSelect(field.id)}
                    value={field.name}
                  >
                    <span className="flex-1 truncate">{field.name}</span>
                    <Badge className="ml-2 shrink-0" variant="secondary">
                      {FIELD_TYPE_LABELS[field.fieldType]}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup>
                <CommandItem onSelect={handleCreateNew} value="__create_new__">
                  <PlusIcon className="h-4 w-4" />
                  Create new field
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <CreateCustomFieldDialog
        onOpenChange={setCreateDialogOpen}
        open={createDialogOpen}
      />
    </>
  );
}
