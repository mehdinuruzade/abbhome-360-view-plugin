import {
  KNOWN_STATUSES,
  type Apartment,
  type ApartmentFilter,
  type ApartmentPatch,
  type KnownStatus,
} from './types';

export const STATUS_COLORS: Readonly<Record<KnownStatus | 'unknown', string>> = {
  available: '#2f9e5b',
  reserved: '#e3a33b',
  sold: '#8e959c',
  unknown: '#b3b8bd',
};

export function knownStatus(status: string): KnownStatus | null {
  return (KNOWN_STATUSES as readonly string[]).includes(status) ? (status as KnownStatus) : null;
}

export function statusColor(status: string): string {
  return STATUS_COLORS[knownStatus(status) ?? 'unknown'];
}

export function isSelectable(a: Apartment, selectable: readonly string[]): boolean {
  return selectable.includes(a.status);
}

function inRange(value: number | undefined, min?: number, max?: number): boolean {
  if (min === undefined && max === undefined) return true;
  if (value === undefined) return false;
  return (min === undefined || value >= min) && (max === undefined || value <= max);
}

/** A null or empty filter matches everything. A constrained field the apartment lacks fails. */
export function matchesFilter(a: Apartment, f: ApartmentFilter | null | undefined): boolean {
  if (!f) return true;
  if (f.ids && !f.ids.includes(a.id)) return false;
  if (f.status && !f.status.includes(a.status)) return false;
  if (f.rooms && (a.rooms === undefined || !f.rooms.includes(a.rooms))) return false;
  if (!inRange(a.floor, f.minFloor, f.maxFloor)) return false;
  if (!inRange(a.price?.amountMinor, f.minPrice, f.maxPrice)) return false;
  if (!inRange(a.areaM2, f.minArea, f.maxArea)) return false;
  return true;
}

/** Merges host updates (e.g. live status or price) by id. Unknown ids are reported, not added. */
export function applyPatches(
  apartments: readonly Apartment[],
  patches: readonly ApartmentPatch[],
): { apartments: Apartment[]; unknownIds: string[] } {
  const byId = new Map<string, ApartmentPatch>();
  for (const p of patches) byId.set(p.id, { ...byId.get(p.id), ...p });
  const seen = new Set<string>();
  const next = apartments.map((a) => {
    const p = byId.get(a.id);
    if (!p) return a;
    seen.add(a.id);
    const merged: Apartment = { ...a };
    for (const [k, v] of Object.entries(p)) if (v !== undefined) merged[k] = v;
    return merged;
  });
  return { apartments: next, unknownIds: [...byId.keys()].filter((id) => !seen.has(id)) };
}

export const DEFAULT_NUMBER_PATTERN = '{floor}{nn}';

/** `{floor}` → level, `{n}` / `{nn}` / `{nnn}` → index zero-padded to 1, 2 or 3 digits. */
export function formatUnitNumber(pattern: string, level: number, index: number): string {
  return pattern
    .replaceAll('{floor}', String(level))
    .replaceAll('{nnn}', String(index).padStart(3, '0'))
    .replaceAll('{nn}', String(index).padStart(2, '0'))
    .replaceAll('{n}', String(index));
}
