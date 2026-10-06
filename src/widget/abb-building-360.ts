import { LitElement, css, html, nothing, type PropertyValues } from 'lit';
import { applyPatches, isSelectable, matchesFilter, STATUS_COLORS } from '../core/apartments';
import { parseConfig } from '../core/parse-config';
import { KNOWN_STATUSES, type Apartment, type ApartmentFilter, type ApartmentPatch, type BuildingConfig } from '../core/types';
import { BuildingScene, type PickEventDetail } from '../scene/building-scene';
import { renderDetails } from './details-panel';
import { formatArea, formatPrice, safeLocale, t, type MessageKey } from './i18n';

/** `detail` of apartment-hover (or null), apartment-preview and apartment-select. */
export interface ApartmentEventDetail {
  apartmentId: string;
  number: string;
  floor: number;
  status: string;
}

export interface ReadyEventDetail {
  buildingId: string;
  apartments: number;
  /** Problems in the config that were worked around. */
  warnings: string[];
}

export interface ErrorEventDetail {
  message: string;
  cause?: unknown;
}

type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
const HINT_MS = 6000;
/** Keep in sync with the `@container (max-width: …)` rule in the styles. */
const COMPACT_MAX_WIDTH = 560;

/**
 * `<abb-building-360>`: the embeddable 3D building.
 *
 * Attributes: `config-url`, `locale`. Properties: `config` (an object instead of a URL),
 * `selectable` (statuses that can be selected, default ['available']).
 * Events (bubbling, composed): `ready`, `error`, `apartment-hover`, `apartment-preview` (a tap
 * opened the details panel) and `apartment-select` (the panel's Select button).
 * Calls from the host page (openApartment, setApartments, setFilter) never emit events.
 */
export class AbbBuilding360 extends LitElement {
  static override properties = {
    // Own accessors (below): switching building resets the host's live updates.
    configUrl: { type: String, attribute: 'config-url', noAccessor: true },
    config: { attribute: false, noAccessor: true },
    locale: { type: String },
    selectable: { attribute: false },
    _building: { state: true },
    _selectedId: { state: true },
    _hover: { state: true },
    _status: { state: true },
    _errorKey: { state: true },
    _hintVisible: { state: true },
  };

  declare locale: string;
  declare selectable: string[];
  declare protected _building: BuildingConfig | null;
  declare protected _selectedId: string | null;
  declare protected _hover: { id: string; x: number; y: number } | null;
  declare protected _status: LoadStatus;
  declare protected _errorKey: MessageKey;
  declare protected _hintVisible: boolean;

  private scene: BuildingScene | null = null;
  private hostResize: ResizeObserver | null = null;
  private filter: ApartmentFilter | null = null;
  private configUrlValue: string | undefined = undefined;
  private configValue: unknown = undefined;
  /** The host's live updates, merged by id and re-applied after every load (reloads included). */
  private readonly livePatches = new Map<string, ApartmentPatch>();
  /** The host switched building and the new one hasn't started loading yet. */
  private switching = false;
  private loadToken = 0;
  private abort: AbortController | null = null;
  private hintTimer = 0;
  private lastHoverId: string | null = null;

  constructor() {
    super();
    this.locale = 'en';
    this.selectable = ['available'];
    this._building = null;
    this._selectedId = null;
    this._hover = null;
    this._status = 'idle';
    this._errorKey = 'loadError';
    this._hintVisible = true;
  }

  // ── Host API ─────────────────────────────────────────────────────────────────────────────

  /** URL of building.json (attribute `config-url`). */
  get configUrl(): string | undefined {
    return this.configUrlValue;
  }

  set configUrl(value: string | undefined) {
    const old = this.configUrlValue;
    if (value === old) return;
    this.configUrlValue = value;
    this.buildingSwitched(old);
    this.requestUpdate('configUrl', old);
  }

  /** A config object instead of a URL; takes priority over `configUrl`. */
  get config(): unknown {
    return this.configValue;
  }

  set config(value: unknown) {
    const old = this.configValue;
    if (value === old) return;
    this.configValue = value;
    this.buildingSwitched(old);
    this.requestUpdate('config', old);
  }

  /** A different building: its live data starts fresh, and nothing applies to the old one. */
  private buildingSwitched(old: unknown): void {
    if (old === undefined || old === null) return;
    this.livePatches.clear();
    this.switching = true;
  }

  /** The parsed config currently shown, or null. */
  get building(): BuildingConfig | null {
    return this._building;
  }

  /** Opens an apartment's details and turns the camera to it. Emits nothing. */
  openApartment(id: string): boolean {
    const a = this.apartment(id);
    if (!a) return false;
    this.open(a);
    return true;
  }

  closeApartment(): void {
    if (!this._selectedId) return;
    this._selectedId = null;
    this.scene?.setOverlayState({ selected: null });
    if (this.isCompact()) this.scene?.overview();
  }

  /**
   * Live updates from the host (status, price…), merged by id. They also survive reloads.
   * Returns the ids the shown building doesn't have; while a building is loading, the updates
   * are kept for it and nothing is returned.
   */
  setApartments(patches: ApartmentPatch[]): string[] {
    for (const p of patches) this.livePatches.set(p.id, { ...this.livePatches.get(p.id), ...p });
    if (this._status !== 'ready' || this.switching || !this._building) return [];
    const { apartments, unknownIds } = applyPatches(this._building.apartments, patches);
    this._building = { ...this._building, apartments };
    this.scene?.updateApartments(apartments);
    this.scene?.setOverlayState({ visible: this.visibility() });
    return unknownIds;
  }

  /** Dims apartments that don't match; null shows everything. */
  setFilter(filter: ApartmentFilter | null): void {
    this.filter = filter;
    this.scene?.setOverlayState({ visible: this.visibility() });
  }

  /** Viewport coordinates of an apartment as currently drawn, or null if it's out of view. */
  getApartmentScreenPosition(id: string): { x: number; y: number } | null {
    return this.scene?.screenPosition(id) ?? null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────────────────

  override connectedCallback(): void {
    super.connectedCallback();
    void this.updateComplete.then(() => this.setup());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    // Moving the element in the DOM disconnects and reconnects it in one task; keep the scene.
    queueMicrotask(() => {
      if (!this.isConnected) this.teardown();
    });
  }

  protected override updated(changed: PropertyValues): void {
    if (this.scene && (changed.has('configUrl') || changed.has('config'))) void this.loadBuilding();
    if (changed.has('_selectedId')) this.syncViewInset();
  }

  /** Keeps the building centred in the part of the view the details panel doesn't cover. */
  private readonly syncViewInset = () => {
    if (!this.scene) return;
    const panel = this.renderRoot.querySelector<HTMLElement>('.panel');
    if (!panel) {
      this.scene.setViewInset({});
      return;
    }
    const host = this.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const bottomSheet = p.width >= host.width - 1;
    this.scene.setViewInset(bottomSheet ? { bottom: host.bottom - p.top } : { right: host.right - p.left });
  };

  private setup(): void {
    if (this.scene || !this.isConnected) return;
    const stage = this.renderRoot.querySelector<HTMLElement>('.stage');
    if (!stage) return;
    try {
      this.scene = new BuildingScene(stage, {
        reducedMotion: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
      });
    } catch (cause) {
      this.fail('webglError', cause);
      return;
    }
    this.scene.addEventListener('pick', this.onPick);
    this.scene.addEventListener('hover', this.onHover);
    this.scene.addEventListener('texture-error', this.onTextureError);
    stage.addEventListener('pointerdown', this.hideHint, { once: true });
    this.hostResize = new ResizeObserver(this.syncViewInset);
    this.hostResize.observe(this);
    void this.loadBuilding();
  }

  private teardown(): void {
    this.loadToken++;
    this.abort?.abort();
    window.clearTimeout(this.hintTimer);
    this.hostResize?.disconnect();
    this.hostResize = null;
    this.scene?.dispose();
    this.scene = null;
    this._status = 'idle';
  }

  private async loadBuilding(): Promise<void> {
    const scene = this.scene;
    if (!scene) return;
    const token = ++this.loadToken;
    this.abort?.abort();
    const abort = (this.abort = new AbortController());
    this.switching = false;
    this._selectedId = null;
    this._hover = null;
    const url = this.configUrl;
    let raw = this.config;
    if ((raw === undefined || raw === null) && !url) {
      this._status = 'idle';
      return;
    }
    this._status = 'loading';
    this._building = null;
    try {
      let base = document.baseURI;
      if ((raw === undefined || raw === null) && url) {
        base = new URL(url, document.baseURI).href;
        const res = await fetch(base, { signal: abort.signal, credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} for ${base}`);
        raw = await res.json();
      }
      const { config, warnings } = parseConfig(raw, base);
      for (const w of warnings) console.warn(`[abb-building-360] ${w}`);
      config.apartments = this.withLivePatches(config.apartments);
      await scene.load(config, { signal: abort.signal });
      if (token !== this.loadToken) return;
      // Updates that arrived while the photos were loading.
      config.apartments = this.withLivePatches(config.apartments);
      scene.updateApartments(config.apartments);
      this._building = config;
      this._status = 'ready';
      scene.setOverlayState({ selected: null, hover: null, visible: this.visibility() });
      this.hintTimer = window.setTimeout(this.hideHint, HINT_MS);
      this.emit<ReadyEventDetail>('ready', {
        buildingId: config.id,
        apartments: config.apartments.length,
        warnings,
      });
    } catch (cause) {
      if (abort.signal.aborted || token !== this.loadToken) return;
      this.fail('loadError', cause);
    }
  }

  private fail(key: MessageKey, cause: unknown): void {
    this._status = 'error';
    this._errorKey = key;
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[abb-building-360] ${message}`);
    this.emit<ErrorEventDetail>('error', { message, cause });
  }

  // ── Interaction ──────────────────────────────────────────────────────────────────────────

  private apartment(id: string): Apartment | undefined {
    return this._building?.apartments.find((a) => a.id === id);
  }

  private withLivePatches(apartments: Apartment[]): Apartment[] {
    return this.livePatches.size ? applyPatches(apartments, [...this.livePatches.values()]).apartments : apartments;
  }

  private visibility(): ((a: Apartment) => boolean) | null {
    const f = this.filter;
    return f ? (a) => matchesFilter(a, f) : null;
  }

  private detailOf(a: Apartment): ApartmentEventDetail {
    return { apartmentId: a.id, number: a.number, floor: a.floor, status: a.status };
  }

  private emit<T>(type: string, detail: T): void {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }));
  }

  /** Narrow layout: the details panel becomes a bottom sheet (matches the container query). */
  private isCompact(): boolean {
    return this.getBoundingClientRect().width <= COMPACT_MAX_WIDTH;
  }

  private open(a: Apartment): void {
    this._selectedId = a.id;
    this._hover = null;
    this.scene?.setOverlayState({ selected: a.id, hover: null });
    this.scene?.flyTo(a.id, { closeUp: this.isCompact() });
  }

  private readonly onPick = (e: Event) => {
    const { id } = (e as CustomEvent<PickEventDetail>).detail;
    this.hideHint();
    const a = id ? this.apartment(id) : undefined;
    if (!a) {
      this.closeApartment();
      return;
    }
    this.open(a);
    this.emit<ApartmentEventDetail>('apartment-preview', this.detailOf(a));
  };

  private readonly onHover = (e: Event) => {
    const { id, x, y } = (e as CustomEvent<PickEventDetail>).detail;
    const rect = this.getBoundingClientRect();
    this._hover = id ? { id, x: x - rect.left, y: y - rect.top } : null;
    this.scene?.setOverlayState({ hover: id });
    if (id !== this.lastHoverId) {
      this.lastHoverId = id;
      const a = id ? this.apartment(id) : undefined;
      this.emit<ApartmentEventDetail | null>('apartment-hover', a ? this.detailOf(a) : null);
    }
  };

  private readonly onTextureError = (e: Event) => {
    const { facade, url } = (e as CustomEvent<{ facade: string; url: string }>).detail;
    console.warn(`[abb-building-360] couldn't load the ${facade} image (${url}); showing a plain wall`);
  };

  private readonly hideHint = () => {
    window.clearTimeout(this.hintTimer);
    this._hintVisible = false;
  };

  private onSelect(a: Apartment): void {
    if (!isSelectable(a, this.selectable)) return;
    this.emit<ApartmentEventDetail>('apartment-select', this.detailOf(a));
  }

  // ── Rendering ────────────────────────────────────────────────────────────────────────────

  protected override render() {
    const locale = safeLocale(this.locale);
    const selected = this._selectedId ? this.apartment(this._selectedId) : undefined;
    const name = this._building?.name || 'the building';
    return html`
      <div class="stage" role="img" aria-label=${t(locale, 'viewLabel', { name })}></div>
      ${this._status === 'loading' ? html`<div class="state" role="status">${t(locale, 'loading')}</div>` : nothing}
      ${this._status === 'error' ? html`<div class="state" role="alert">${t(locale, this._errorKey)}</div>` : nothing}
      ${this._status === 'ready' ? this.renderLegend(locale) : nothing}
      ${this._status === 'ready' && this._hintVisible ? this.renderHint(locale) : nothing}
      ${this._hover && this._hover.id !== this._selectedId ? this.renderTooltip(locale) : nothing}
      ${selected
        ? renderDetails(selected, {
            locale,
            selectable: isSelectable(selected, this.selectable),
            onClose: () => this.closeApartment(),
            onSelect: () => this.onSelect(selected),
          })
        : nothing}
    `;
  }

  private renderLegend(locale: string) {
    const counts = new Map<string, number>();
    for (const a of this._building?.apartments ?? []) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
    return html`
      <ul class="legend ${this._selectedId ? 'has-selection' : ''}" aria-label=${t(locale, 'legend')}>
        ${KNOWN_STATUSES.map(
          (s) => html`<li><span class="dot" style="--status:${STATUS_COLORS[s]}"></span>${t(locale, `status.${s}`)}
            <span class="count">${counts.get(s) ?? 0}</span></li>`,
        )}
      </ul>
    `;
  }

  private renderHint(locale: string) {
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    return html`<p class="hint">${t(locale, coarse ? 'hintTouch' : 'hintMouse')}</p>`;
  }

  private renderTooltip(locale: string) {
    const hover = this._hover;
    const a = hover ? this.apartment(hover.id) : undefined;
    if (!hover || !a) return nothing;
    const facts = [
      a.rooms !== undefined ? t(locale, 'roomsShort', { rooms: a.rooms }) : null,
      a.areaM2 !== undefined ? formatArea(a.areaM2, locale) : null,
      a.price ? formatPrice(a.price, locale) : null,
    ].filter(Boolean);
    return html`
      <div class="tooltip" style="left:${hover.x}px;top:${hover.y}px">
        <strong>${t(locale, 'apartment', { number: a.number })}</strong>
        <span>${facts.join(' · ')}</span>
      </div>
    `;
  }

  static override styles = css`
    :host {
      --abb360-accent: #1d2733;
      --abb360-accent-text: #ffffff;
      --abb360-surface: #ffffff;
      --abb360-text: #1d2733;
      --abb360-muted: #5b6673;
      --abb360-radius: 12px;
      --abb360-background: linear-gradient(180deg, #cfdbe6 0%, #e9eef2 55%, #f3f4f2 100%);
      display: block;
      position: relative;
      aspect-ratio: 4 / 3;
      min-height: 320px;
      overflow: hidden;
      container-type: inline-size;
      border-radius: var(--abb360-radius);
      background: var(--abb360-background);
      color: var(--abb360-text);
      font-family: var(--abb360-font, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif);
      font-size: 14px;
      line-height: 1.4;
      -webkit-tap-highlight-color: transparent;
    }
    @media (max-width: 600px) {
      :host {
        aspect-ratio: 4 / 5;
      }
    }
    :host([hidden]) {
      display: none;
    }
    * {
      box-sizing: border-box;
    }
    .stage {
      position: absolute;
      inset: 0;
    }
    .state {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      text-align: center;
      color: var(--abb360-muted);
    }
    .legend {
      position: absolute;
      left: 12px;
      top: 12px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px 12px;
      margin: 0;
      padding: 6px 10px;
      list-style: none;
      border-radius: 8px;
      background: color-mix(in srgb, var(--abb360-surface) 88%, transparent);
      box-shadow: 0 1px 3px rgb(0 0 0 / 0.12);
      font-size: 12px;
      pointer-events: none;
    }
    .legend li {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--status);
    }
    .count {
      color: var(--abb360-muted);
    }
    .hint {
      position: absolute;
      left: 50%;
      bottom: 12px;
      transform: translateX(-50%);
      margin: 0;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgb(29 39 51 / 0.78);
      color: #fff;
      font-size: 12px;
      white-space: nowrap;
      pointer-events: none;
    }
    .tooltip {
      position: absolute;
      transform: translate(12px, -50%);
      display: grid;
      gap: 2px;
      padding: 8px 10px;
      border-radius: 8px;
      background: var(--abb360-surface);
      box-shadow: 0 4px 16px rgb(0 0 0 / 0.16);
      font-size: 12px;
      white-space: nowrap;
      pointer-events: none;
    }
    .tooltip span {
      color: var(--abb360-muted);
    }
    .panel {
      position: absolute;
      top: 12px;
      right: 12px;
      bottom: 12px;
      width: min(320px, 46%);
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      overflow-y: auto;
      border-radius: var(--abb360-radius);
      background: var(--abb360-surface);
      box-shadow: 0 8px 32px rgb(0 0 0 / 0.18);
    }
    .body {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    @container (max-width: 560px) {
      .panel {
        top: auto;
        left: 0;
        right: 0;
        bottom: 0;
        width: auto;
        max-height: 62%;
        gap: 10px;
        padding: 14px 16px 16px;
        border-radius: var(--abb360-radius) var(--abb360-radius) 0 0;
      }
      .body {
        display: grid;
        grid-template-columns: 104px minmax(0, 1fr);
        align-items: start;
      }
      .body.no-plan {
        grid-template-columns: minmax(0, 1fr);
      }
      .plan {
        max-height: 104px;
      }
      .facts {
        gap: 6px 12px;
      }
      .legend {
        right: 12px;
      }
      .legend.has-selection {
        display: none;
      }
    }
    .panel-head {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .eyebrow {
      margin: 0;
      color: var(--abb360-muted);
      font-size: 12px;
    }
    h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }
    .icon {
      flex: none;
      display: grid;
      place-items: center;
      width: 32px;
      height: 32px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
    }
    .icon:hover {
      background: rgb(0 0 0 / 0.06);
    }
    .icon svg {
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.6;
      stroke-linecap: round;
    }
    .badge {
      align-self: flex-start;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--status) 16%, transparent);
      font-size: 12px;
      font-weight: 600;
    }
    .badge::before {
      content: '';
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--status);
    }
    .plan {
      width: 100%;
      max-height: 200px;
      object-fit: contain;
      border: 1px solid rgb(0 0 0 / 0.08);
      border-radius: 8px;
      background: #fff;
    }
    .facts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px 16px;
      margin: 0;
    }
    .facts dt {
      color: var(--abb360-muted);
      font-size: 12px;
    }
    .facts dd {
      margin: 0;
      font-weight: 600;
    }
    .primary {
      margin-top: auto;
      min-height: 44px;
      padding: 10px 16px;
      border: 0;
      border-radius: 10px;
      background: var(--abb360-accent);
      color: var(--abb360-accent-text);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .primary:disabled {
      background: rgb(0 0 0 / 0.08);
      color: var(--abb360-muted);
      cursor: not-allowed;
    }
    .primary:focus-visible,
    .icon:focus-visible {
      outline: 2px solid var(--abb360-accent);
      outline-offset: 2px;
    }
  `;
}
