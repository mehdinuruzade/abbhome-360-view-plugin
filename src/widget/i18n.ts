import type { Money } from '../core/types';

/**
 * English strings for now; add a locale by adding a table with the same keys. Prices and areas
 * use Intl with the requested locale, so number formatting is local even before translation.
 */
const en = {
  apartment: 'Apartment {number}',
  floor: 'Floor',
  floorN: 'Floor {floor}',
  rooms: 'Rooms',
  area: 'Area',
  price: 'Price',
  priceOnRequest: 'Price on request',
  'status.available': 'Available',
  'status.reserved': 'Reserved',
  'status.sold': 'Sold',
  'status.unknown': 'Not available',
  select: 'Select apartment',
  close: 'Close',
  loading: 'Loading the building…',
  loadError: "Couldn't load this building. Please try again later.",
  webglError: "This device can't show the 3D view.",
  hintMouse: 'Drag to rotate · Ctrl/⌘ + scroll to zoom',
  hintTouch: 'Swipe sideways to rotate · pinch to zoom',
  planAlt: 'Floor plan of apartment {number}',
  viewLabel: '3D view of {name}. Tap an apartment to see its details.',
  legend: 'Apartment status',
  roomsShort: '{rooms} rooms',
} as const;

export type MessageKey = keyof typeof en;

const tables: Record<string, Partial<Record<MessageKey, string>>> = { en };

/** A valid BCP 47 tag, or 'en'. */
export function safeLocale(locale: string | undefined): string {
  if (!locale) return 'en';
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

export function t(locale: string, key: MessageKey, vars: Record<string, string | number> = {}): string {
  const lang = locale.toLowerCase().split('-')[0] ?? 'en';
  const template = tables[locale]?.[key] ?? tables[lang]?.[key] ?? en[key];
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
}

export function statusKey(status: string): MessageKey {
  return status === 'available' || status === 'reserved' || status === 'sold'
    ? `status.${status}`
    : 'status.unknown';
}

/** Whole currency units (apartment prices don't need cents), in the currency's own minor unit. */
export function formatPrice(money: Money, locale: string): string {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency: money.currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: money.currency,
      maximumFractionDigits: 0,
    }).format(money.amountMinor / 10 ** digits);
  } catch {
    return `${(money.amountMinor / 100).toFixed(0)} ${money.currency}`;
  }
}

export function formatArea(m2: number, locale: string): string {
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(m2)} m²`;
}
