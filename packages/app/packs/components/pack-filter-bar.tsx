import type { Harness } from "@repo/app/agents/lib/session-types";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@repo/design-system/components/ui/card";
import { Input } from "@repo/design-system/components/ui/input";
import { Label } from "@repo/design-system/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@repo/design-system/components/ui/select";

type PackFilterBarProps = {
  query?: string;
  harness?: string;
  harnesses: Harness[];
  onQueryChange?: (value: string) => void;
  onHarnessChange?: (value: string) => void;
  title?: string;
  description?: string;
};

export function PackFilterBar({
  query = "",
  harness = "all",
  harnesses,
  onQueryChange,
  onHarnessChange,
  title = "Discover",
  description = "Filter the shared pack catalog before opening detail or install flows.",
}: PackFilterBarProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-[1fr_12rem]">
        <div className="space-y-2">
          <Label htmlFor="pack-search">Search packs</Label>
          <Input
            id="pack-search"
            onChange={(event) => onQueryChange?.(event.target.value)}
            placeholder="Search by name, id, or description"
            value={query}
          />
        </div>
        <div className="space-y-2">
          <Label>Harness</Label>
          <Select onValueChange={onHarnessChange} value={harness}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All harnesses</SelectItem>
              {harnesses.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
