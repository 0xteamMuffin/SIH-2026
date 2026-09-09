import { Icon } from "./Icon.js";

export interface AvatarProps {
  /** Email or display name. Drives both the initials and the colour. */
  name: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

/**
 * Initials avatar.
 *
 * The hue is derived from the identity rather than picked from a rotating
 * palette, so the same account is always the same colour — on a shared
 * deployment that is what makes "whose session is this" answerable without
 * reading the address.
 */
export function Avatar({ name, size = "md", className = "" }: AvatarProps): React.JSX.Element {
  return (
    <span
      className={`avatar ${size === "sm" ? "avatar--sm" : size === "lg" ? "avatar--lg" : ""} ${className}`}
      style={{ "--avatar-hue": hueFor(name) } as React.CSSProperties}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

/** The agent's mark. One identity, so it carries the product accent. */
export function AgentAvatar({
  size = "md",
  className = "",
}: {
  size?: "sm" | "md" | "lg";
  className?: string;
}): React.JSX.Element {
  return (
    <span
      className={`avatar avatar--agent ${size === "sm" ? "avatar--sm" : size === "lg" ? "avatar--lg" : ""} ${className}`}
      aria-hidden="true"
    >
      <Icon name="sparkles" size={size === "lg" ? 16 : size === "sm" ? 11 : 13} strokeWidth={1.6} />
    </span>
  );
}

/**
 * Two initials where the name has parts, otherwise the first two characters
 * of the local part — `a.hassan@dept.gov` reads better as "AH" than as "A@".
 */
function initialsOf(name: string): string {
  const local = name.split("@")[0] ?? name;
  const parts = local.split(/[\s._-]+/).filter(Boolean);

  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`;
  }
  return local.slice(0, 2) || "?";
}

/**
 * FNV-1a, for a stable hue that does not cluster the way `charCodeAt` sums do.
 *
 * Constrained to 10°–54° — reds through ambers. The full wheel would put a
 * cyan or magenta chip into a warm-graphite-and-copper interface, which is
 * precisely the sort of stray hue that makes a UI look assembled from parts.
 */
function hueFor(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return 10 + (Math.abs(hash) % 45);
}
