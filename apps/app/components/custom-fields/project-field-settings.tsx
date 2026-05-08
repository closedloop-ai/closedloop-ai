"use client";

import type { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { Badge } from "@repo/design-system/components/ui/badge";
import { Button } from "@repo/design-system/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Switch } from "@repo/design-system/components/ui/switch";
import { Trash2Icon } from "lucide-react";
import {
  useAttachCustomField,
  useCustomFieldSettings,
  useDetachCustomField,
} from "@/hooks/queries/use-custom-fields";
import { AddFieldPopover } from "./add-field-popover";
import { FIELD_TYPE_LABELS } from "./constants";

type ProjectFieldSettingsProps = {
  entityType: CustomFieldEntityType;
  entityId: string;
};

export function ProjectFieldSettings({
  entityType,
  entityId,
}: Readonly<ProjectFieldSettingsProps>) {
  const { data: settings = [] } = useCustomFieldSettings(entityType, entityId);
  const attachCustomField = useAttachCustomField(entityType, entityId);
  const detachCustomField = useDetachCustomField(entityType, entityId);

  // TODO: These toggle handlers use POST (attachField/create) when they should use
  // PATCH/PUT (update). The current settings infrastructure doesn't have a PATCH
  // endpoint for updating isImportant/isRequired on an existing setting. This works
  // because createMany uses skipDuplicates, but a proper PATCH endpoint should be added.
  const handleVisibleToggle = async (
    customFieldId: string,
    currentValue: boolean
  ) => {
    await attachCustomField.mutateAsync({
      customFieldId,
      isImportant: !currentValue,
    });
  };

  const handleRequiredToggle = async (
    customFieldId: string,
    currentValue: boolean
  ) => {
    await attachCustomField.mutateAsync({
      customFieldId,
      isRequired: !currentValue,
    });
  };

  const handleRemove = async (customFieldId: string) => {
    await detachCustomField.mutateAsync(customFieldId);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Custom Fields</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {settings.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No custom fields attached yet.
          </p>
        ) : (
          <div className="rounded-md border">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-2 text-left font-medium">Name</th>
                  <th className="px-4 py-2 text-left font-medium">Type</th>
                  <th className="px-4 py-2 text-center font-medium">Visible</th>
                  <th className="px-4 py-2 text-center font-medium">
                    Required
                  </th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {settings.map((setting) => (
                  <tr
                    className="border-b last:border-b-0 hover:bg-muted/25"
                    key={setting.id}
                  >
                    <td className="px-4 py-2 font-medium">
                      {setting.customField.name}
                    </td>
                    <td className="px-4 py-2">
                      <Badge variant="secondary">
                        {FIELD_TYPE_LABELS[setting.customField.fieldType]}
                      </Badge>
                    </td>
                    <td className="px-4 py-2 text-center">
                      <Switch
                        checked={setting.isImportant}
                        onCheckedChange={() =>
                          handleVisibleToggle(
                            setting.customFieldId,
                            setting.isImportant
                          )
                        }
                      />
                    </td>
                    <td className="px-4 py-2 text-center">
                      <Switch
                        checked={setting.isRequired}
                        onCheckedChange={() =>
                          handleRequiredToggle(
                            setting.customFieldId,
                            setting.isRequired
                          )
                        }
                      />
                    </td>
                    <td className="px-4 py-2">
                      <Button
                        onClick={() => handleRemove(setting.customFieldId)}
                        size="icon-sm"
                        variant="ghost"
                      >
                        <Trash2Icon className="h-4 w-4 text-muted-foreground" />
                        <span className="sr-only">Remove field</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="pt-2">
          <AddFieldPopover entityId={entityId} entityType={entityType} />
        </div>
      </CardContent>
    </Card>
  );
}
