import { LitElement, css, html, nothing, svg, type PropertyValues } from 'lit';
import { statusColor } from '../core/apartments';
import { pointInPolygon, polygonCentroid } from '../core/geometry2d';
import type { Apartment, Corners, EditorData, FacadeId, Region, UnitCell, Vec2 } from '../core/types';
import { loadImage, rectify } from './rectify';
import { columnBounds, levelBands } from './state';

export type FacadeMode = 'floors' | 'columns' | 'apartments';

const TAP_SLOP = 5;
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/**
 * One wall drawn straight-on, with the editor's grid over it. Everything inside is in facade
 * space: the SVG uses a 0..1 viewBox stretched over the wall, so (u, v) are SVG coordinates.
 */
export class FacadeView extends LitElement {
  static override properties = {
    src: { type: String },
    corners: { attribute: false },
    aspect: { type: Number },
    facade: { type: String },
    mode: { type: String },
    editor: { attribute: false },
    apartments: { attribute: false },
    regions: { attribute: false },
    selectedCells: { attribute: false },
    levelRange: { attribute: false },
    selectedApartment: { attribute: false },
    _canvas: { state: true },
  };

  declare src: string;
  declare corners: Corners;
  declare aspect: number;
  declare facade: FacadeId;
  declare mode: FacadeMode;
  declare editor: EditorData;
  declare apartments: Apartment[];
  declare regions: Region[];
  declare selectedCells: UnitCell[];
  declare levelRange: [number, number];
  declare selectedApartment: string | null;
  declare protected _canvas: HTMLCanvasElement | null;

  private drag: { kind: 'floor' | 'divider'; index: number; pointerId: number } | null = null;
  private press: { x: number; y: number; pointerId: number } | null = null;
  private renderToken = 0;

  constructor() {
    super();
    this.src = '';
    this.corners = { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] };
    this.aspect = 0.7;
    this.facade = 'front';
    this.mode = 'floors';
    this.apartments = [];
    this.regions = [];
    this.selectedCells = [];
    this.levelRange = [0, 0];
    this.selectedApartment = null;
    this._canvas = null;
  }

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('src') || changed.has('corners') || changed.has('aspect')) void this.redrawImage();
  }

  private async redrawImage() {
    const token = ++this.renderToken;
    if (!this.src) {
      this._canvas = null;
      return;
    }
    try {
      const img = await loadImage(this.src);
      if (token !== this.renderToken) return;
      const height = 1000;
      const width = Math.min(1600, height * this.aspect);
      this._canvas = rectify(img, this.corners, width, height);
    } catch {
      if (token === this.renderToken) this._canvas = null;
    }
  }

  private uv(e: PointerEvent): Vec2 {
    const rect = this.renderRoot.querySelector('.frame')?.getBoundingClientRect();
    if (!rect || !rect.width) return [0, 0];
    return [clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height)];
  }

  private fire<T>(type: string, detail: T) {
    this.dispatchEvent(new CustomEvent<T>(type, { detail, bubbles: true, composed: true }));
  }

  private startDrag(kind: 'floor' | 'divider', index: number, e: PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag = { kind, index, pointerId: e.pointerId };
  }

  private onMove(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const [u, v] = this.uv(e);
    if (this.drag.kind === 'floor') this.fire('floor-move', { index: this.drag.index, v, final: false });
    else this.fire('divider-move', { index: this.drag.index, u, final: false });
  }

  private onUp(e: PointerEvent) {
    if (this.drag && e.pointerId === this.drag.pointerId) {
      const [u, v] = this.uv(e);
      if (this.drag.kind === 'floor') this.fire('floor-move', { index: this.drag.index, v, final: true });
      else this.fire('divider-move', { index: this.drag.index, u, final: true });
      this.drag = null;
      return;
    }
    if (!this.press || e.pointerId !== this.press.pointerId) return;
    const moved = Math.hypot(e.clientX - this.press.x, e.clientY - this.press.y);
    this.press = null;
    if (moved <= TAP_SLOP) this.onTap(this.uv(e));
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0) return;
    this.press = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
  }

  private onTap([u, v]: Vec2) {
    if (this.mode === 'columns') {
      this.fire('divider-add', { u });
      return;
    }
    if (this.mode !== 'apartments') return;
    const hit = this.regions.find((r) => r.facade === this.facade && pointInPolygon([u, v], r.polygon));
    if (hit) {
      this.fire('apartment-pick', { id: hit.apartmentId });
      return;
    }
    const col = columnBounds(this.editor, this.facade).findIndex(([u0, u1]) => u >= u0 && u <= u1);
    if (col >= 0) this.fire('column-toggle', { col });
  }

  private onHandleKey(kind: 'floor' | 'divider', index: number, current: number, e: KeyboardEvent) {
    const step = e.shiftKey ? 0.01 : 0.001;
    const forward = kind === 'floor' ? 'ArrowDown' : 'ArrowRight';
    const back = kind === 'floor' ? 'ArrowUp' : 'ArrowLeft';
    if (kind === 'divider' && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault();
      this.fire('divider-remove', { index });
      return;
    }
    if (e.key !== forward && e.key !== back) return;
    e.preventDefault();
    const value = clamp01(current + (e.key === forward ? step : -step));
    if (kind === 'floor') this.fire('floor-move', { index, v: value, final: true });
    else this.fire('divider-move', { index, u: value, final: true });
  }

  protected override render() {
    if (!this.src) return html`<p class="empty">Add this wall's photo first.</p>`;
    const e = this.editor;
    const bands = levelBands(e);
    const dividers = e.dividers[this.facade];
    const cols = columnBounds(e, this.facade);
    const [from, to] = this.levelRange;
    const selectedCols = this.selectedCells.filter((c) => c.facade === this.facade).map((c) => c.col);
    const byId = new Map(this.apartments.map((a) => [a.id, a]));
    const regions = this.regions.filter((r) => r.facade === this.facade);
    return html`
      <div
        class="frame mode-${this.mode}"
        style="aspect-ratio:${this.aspect}"
        @pointerdown=${this.onDown}
        @pointermove=${this.onMove}
        @pointerup=${this.onUp}
        @pointercancel=${() => {
          this.drag = null;
          this.press = null;
        }}
      >
        ${this._canvas ?? nothing}
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          ${regions.map((r) => {
            const a = byId.get(r.apartmentId);
            const selected = r.apartmentId === this.selectedApartment;
            return svg`<polygon class=${selected ? 'region selected' : 'region'} points=${r.polygon.map((p) => p.join(',')).join(' ')}
              style="fill:${a ? statusColor(a.status) : '#999'}" />`;
          })}
          ${this.mode === 'apartments'
            ? selectedCols.flatMap((col) => {
                const span = cols[col];
                if (!span) return [];
                return bands
                  .filter((b) => b.level >= Math.min(from, to) && b.level <= Math.max(from, to))
                  .map((b) => svg`<rect class="pick" x=${span[0]} y=${b.vTop} width=${span[1] - span[0]} height=${b.vBottom - b.vTop} />`);
              })
            : nothing}
          ${e.floorLines.map((v) => svg`<line class="floor" x1="0" x2="1" y1=${v} y2=${v} />`)}
          ${dividers.map((u) => svg`<line class="divider" x1=${u} x2=${u} y1="0" y2="1" />`)}
        </svg>
        ${this.mode !== 'columns'
          ? bands.map(
              (b) => html`<span class="level" style="top:${((b.vTop + b.vBottom) / 2) * 100}%">${b.level}</span>`,
            )
          : nothing}
        ${regions.map((r) => {
          const [cu, cv] = polygonCentroid(r.polygon);
          const a = byId.get(r.apartmentId);
          return a ? html`<span class="number" style="left:${cu * 100}%;top:${cv * 100}%">${a.number}</span>` : nothing;
        })}
        ${this.mode === 'floors'
          ? e.floorLines.map(
              (v, i) => html`<button
                class="handle floor-handle"
                type="button"
                style="top:${v * 100}%"
                aria-label="Floor line ${i + 1} of ${e.floorLines.length}"
                @pointerdown=${(ev: PointerEvent) => this.startDrag('floor', i, ev)}
                @keydown=${(ev: KeyboardEvent) => this.onHandleKey('floor', i, v, ev)}
              ></button>`,
            )
          : nothing}
        ${this.mode === 'columns'
          ? dividers.map(
              (u, i) => html`<button
                  class="handle divider-handle"
                  type="button"
                  style="left:${u * 100}%"
                  aria-label="Divider ${i + 1}; arrow keys move it, Delete removes it"
                  @pointerdown=${(ev: PointerEvent) => this.startDrag('divider', i, ev)}
                  @keydown=${(ev: KeyboardEvent) => this.onHandleKey('divider', i, u, ev)}
                  @dblclick=${() => this.fire('divider-remove', { index: i })}
                ></button>
                <button
                  class="remove"
                  type="button"
                  style="left:${u * 100}%"
                  aria-label="Remove divider ${i + 1}"
                  @pointerdown=${(ev: PointerEvent) => ev.stopPropagation()}
                  @click=${() => this.fire('divider-remove', { index: i })}
                >×</button>`,
            )
          : nothing}
      </div>
    `;
  }

  static override styles = css`
    :host {
      display: block;
    }
    .frame {
      position: relative;
      max-height: 70vh;
      max-width: 100%;
      margin: 0 auto;
      background: #e9ecef;
      user-select: none;
      touch-action: none;
    }
    .mode-columns,
    .mode-apartments {
      cursor: crosshair;
    }
    canvas {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
    }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: visible;
      pointer-events: none;
    }
    .region {
      fill-opacity: 0.35;
      stroke: #fff;
      stroke-width: 1;
      vector-effect: non-scaling-stroke;
    }
    .region.selected {
      fill-opacity: 0.7;
      stroke: #1d2733;
      stroke-width: 3;
    }
    .pick {
      fill: rgb(29 111 235 / 0.35);
      stroke: #1d6feb;
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .floor {
      stroke: #ffdd57;
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .mode-floors .floor {
      stroke-width: 2.5;
    }
    .divider {
      stroke: #57d0ff;
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }
    .mode-columns .divider {
      stroke-width: 2.5;
    }
    .level {
      position: absolute;
      left: -30px;
      width: 24px;
      transform: translateY(-50%);
      text-align: right;
      font-size: 11px;
      color: #5b6673;
      pointer-events: none;
    }
    .number {
      position: absolute;
      transform: translate(-50%, -50%);
      padding: 0 3px;
      border-radius: 3px;
      background: rgb(255 255 255 / 0.85);
      color: #1d2733;
      font-size: 10px;
      font-weight: 600;
      pointer-events: none;
    }
    .handle {
      position: absolute;
      padding: 0;
      border: 2px solid #fff;
      background: #1d2733;
      box-shadow: 0 1px 3px rgb(0 0 0 / 0.4);
      touch-action: none;
    }
    .floor-handle {
      left: -14px;
      width: 28px;
      height: 14px;
      margin-top: -7px;
      border-radius: 7px;
      cursor: ns-resize;
      background: #c89b00;
    }
    .divider-handle {
      top: -14px;
      width: 14px;
      height: 28px;
      margin-left: -7px;
      border-radius: 7px;
      cursor: ew-resize;
      background: #0f86b6;
    }
    .remove {
      position: absolute;
      top: -40px;
      width: 20px;
      height: 20px;
      margin-left: -10px;
      padding: 0;
      border: 0;
      border-radius: 50%;
      background: #fff;
      color: #b3261e;
      font-size: 14px;
      line-height: 20px;
      box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
      cursor: pointer;
    }
    .handle:focus-visible,
    .remove:focus-visible {
      outline: 3px solid #1d2733;
      outline-offset: 2px;
    }
    .empty {
      color: #5b6673;
    }
  `;
}

if (!customElements.get('abb360-facade-view')) customElements.define('abb360-facade-view', FacadeView);
