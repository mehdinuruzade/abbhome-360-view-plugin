import type { ApartmentFilter, ApartmentPatch } from '../core/types';
import {
  AbbBuilding360,
  type ApartmentEventDetail,
  type ErrorEventDetail,
  type ReadyEventDetail,
} from './abb-building-360';

export const TAG = 'abb-building-360';
export const version = '0.1.0';

/** Registers the element once, even if the script is included twice. */
export function define(tag = TAG): void {
  if (!customElements.get(tag)) customElements.define(tag, AbbBuilding360);
}

define();

export interface MountOptions {
  /** A config object; takes priority over `configUrl`. */
  config?: unknown;
  /** URL of building.json; image paths inside it resolve against this URL. */
  configUrl?: string;
  locale?: string;
  /** Statuses whose Select button is enabled. Default: ['available']. */
  selectable?: string[];
  onReady?: (detail: ReadyEventDetail) => void;
  onError?: (detail: ErrorEventDetail) => void;
  onHover?: (detail: ApartmentEventDetail | null) => void;
  onPreview?: (detail: ApartmentEventDetail) => void;
  onSelect?: (detail: ApartmentEventDetail) => void;
}

export interface WidgetInstance {
  element: AbbBuilding360;
  openApartment(id: string): boolean;
  closeApartment(): void;
  setApartments(patches: ApartmentPatch[]): string[];
  setFilter(filter: ApartmentFilter | null): void;
  getApartmentScreenPosition(id: string): { x: number; y: number } | null;
  /** Removes the widget (if mount created it) and releases its WebGL context. */
  destroy(): void;
}

/**
 * Puts a widget inside `target` (or configures `target` if it already is one) and wires the
 * callbacks to its events.
 */
export function mount(target: HTMLElement, options: MountOptions = {}): WidgetInstance {
  const created = !(target instanceof AbbBuilding360);
  const el = created ? (document.createElement(TAG) as AbbBuilding360) : (target as AbbBuilding360);
  if (options.locale) el.locale = options.locale;
  if (options.selectable) el.selectable = options.selectable;
  if (options.config !== undefined) el.config = options.config;
  else if (options.configUrl) el.configUrl = options.configUrl;

  const listeners: [string, (e: Event) => void][] = [];
  const on = <T>(type: string, cb?: (detail: T) => void) => {
    if (!cb) return;
    const fn = (e: Event) => cb((e as CustomEvent<T>).detail);
    el.addEventListener(type, fn);
    listeners.push([type, fn]);
  };
  on('ready', options.onReady);
  on('error', options.onError);
  on('apartment-hover', options.onHover);
  on('apartment-preview', options.onPreview);
  on('apartment-select', options.onSelect);
  if (created) target.appendChild(el);

  return {
    element: el,
    openApartment: (id) => el.openApartment(id),
    closeApartment: () => el.closeApartment(),
    setApartments: (patches) => el.setApartments(patches),
    setFilter: (filter) => el.setFilter(filter),
    getApartmentScreenPosition: (id) => el.getApartmentScreenPosition(id),
    destroy() {
      for (const [type, fn] of listeners) el.removeEventListener(type, fn);
      if (created) el.remove();
    },
  };
}

export { AbbBuilding360 };
export type { ApartmentEventDetail, ErrorEventDetail, ReadyEventDetail };
export type {
  Apartment,
  ApartmentFilter,
  ApartmentPatch,
  BuildingConfig,
  Corners,
  Dimensions,
  FacadeId,
  Money,
  Region,
} from '../core/types';

declare global {
  interface HTMLElementTagNameMap {
    'abb-building-360': AbbBuilding360;
  }
}
