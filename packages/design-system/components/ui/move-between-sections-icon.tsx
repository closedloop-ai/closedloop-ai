import { cn } from "@closedloop-ai/design-system/lib/utils";
import type { SVGAttributes } from "react";

interface MoveBetweenSectionsIconProps
  extends SVGAttributes<SVGSVGElement> {
  size?: number;
}

function MoveBetweenSectionsIcon({
  className,
  size = 12,
  ...props
}: MoveBetweenSectionsIconProps) {
  return (
    <svg
      aria-hidden="true"
      className={cn("shrink-0 fill-current", className)}
      focusable="false"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      {...props}
    >
      <path d="M5.85294 9.12337V21.0014L1.50001 16.6927C1.14706 16.3433 0.617647 16.3433 0.264706 16.6927C-0.0882355 17.042 -0.0882355 17.5661 0.264706 17.9154L6.14704 23.738C6.49999 24.0873 7.0294 24.0873 7.38234 23.738L13.2647 17.9154C13.4412 17.7407 13.5 17.5077 13.5 17.2749C13.5 17.042 13.4412 16.8091 13.2647 16.6345C12.9117 16.2851 12.3823 16.2851 12.0294 16.6345L7.67646 20.9432V9.12337C7.67646 8.65756 7.26469 8.24999 6.79411 8.24999C6.38235 8.24999 5.85294 8.65756 5.85294 9.12337ZM16.3529 14.8766V2.99861L12 7.30729C11.647 7.65664 11.1176 7.65664 10.7647 7.30729C10.4117 6.95794 10.4117 6.4339 10.7647 6.08455L16.647 0.262014C17 -0.0873381 17.5293 -0.0873381 17.8823 0.262014L23.7646 6.08455C23.9412 6.25923 24 6.49213 24 6.72503C24 6.95794 23.9412 7.19084 23.7646 7.36552C23.4117 7.71487 22.8824 7.71487 22.5294 7.36552L18.1764 3.05684V14.8766C18.1764 15.3424 17.7647 15.7499 17.2941 15.7499C16.8824 15.7499 16.3529 15.3424 16.3529 14.8766Z" />
    </svg>
  );
}

export { MoveBetweenSectionsIcon };
export type { MoveBetweenSectionsIconProps };
