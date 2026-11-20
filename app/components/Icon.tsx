import { Icon as IconifyIcon, addCollection } from "@iconify/react";
import lucideSubset from "virtual:lucide-subset";

addCollection(lucideSubset);

export interface IconProps {
  name: string;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className = "" }: IconProps) {
  const fullName = name.includes(":") ? name : `lucide:${name}`;
  return (
    <IconifyIcon
      icon={fullName}
      width={size}
      height={size}
      className={className ? `shrink-0 ${className}` : "shrink-0"}
      aria-hidden="true"
    />
  );
}
