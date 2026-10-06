import { LitElement, css, html, nothing, svg } from 'lit';
import { polygonCentroid } from '../core/geometry2d';
import type { Dimensions, FacadeId, Massing, MassingBlock, Vec2 } from '../core/types';
import { insertVertex, moveVertex, removeVertex, snapPoint } from './shape';

export interface ShapeSelection {
  block: number;
  vertex: number | null;
}

export interface ShapeChangeDetail {
  massing: Massing;
}

/** Snap distance in metres, relative to the building (about 40 cm on a 30 m building). */
const SNAP_FRACTION = 0.013;

/**
 * The building from above, front at the bottom. Its four straightened photos lie along the
 * matching sides with the roof line towards the plan (like an exploded elevation drawing), so
 * wall corners and slots seen in the photos line up with the footprint underneath.
 *
 * Drag a corner to move it (snaps to 10 cm, the box edges and square with its neighbours; hold
 * Alt to place freely), drag a + on an edge to add a corner there, Delete removes the selected
 * corner, arrow keys nudge it. Changes are sent on release, so the 3D preview rebuilds once.
 */
export class ShapeView extends LitElement {
  static override properties = {
    dimensions: { attribute: false },
    blocks: { attribute: false },
    photos: { attribute: false },
    selection: { attribute: false },
    draft: { state: true },
  };

  declare dimensions: Dimensions;
  declare blocks: MassingBlock[];
  declare photos: Partial<Record<FacadeId, string | null>>;
  declare selection: ShapeSelection | null;
  /** The shape while a drag is in progress. */
  declare protected draft: Massing | null;
  private drag: { block: number; vertex: number; pointerId: number; changed: boolean } | null = null;

  constructor() {
    super();
    this.dimensions = { width: 30, depth: 20, height: 40 };
    this.blocks = [];
    this.photos = {};
    this.selection = null;
    this.draft = null;
  }

  private get massing(): Massing {
    return this.draft ?? { blocks: this.blocks };
  }

  /** Layout in metres: plan offset and the band the photos sit in. */
  private get layout() {
    const { width: W, depth: D } = this.dimensions;
    const band = 0.26 * Math.max(W, D);
    const gap = 0.035 * Math.max(W, D);
    const o = band + gap;
    return { W, D, band, gap, o, vw: W + 2 * o, vh: D + 2 * o };
  }

  private toSvg([x, d]: Vec2): Vec2 {
    const { o, D } = this.layout;
    return [o + x, o + D - d];
  }

  private toPlan(e: PointerEvent): Vec2 {
    const el = this.renderRoot.querySelector('svg');
    const ctm = el?.getScreenCTM();
    if (!el || !ctm) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    const { o, D } = this.layout;
    return [p.x - o, o + D - p.y];
  }

  private select(selection: ShapeSelection | null) {
    this.dispatchEvent(new CustomEvent<ShapeSelection | null>('shape-select', { detail: selection, bubbles: true, composed: true }));
  }

  private emit(massing: Massing) {
    this.dispatchEvent(new CustomEvent<ShapeChangeDetail>('shape-change', { detail: { massing }, bubbles: true, composed: true }));
  }

  /** `changed`: the shape already differs (a corner was just added), so release sends it even without a move. */
  private startDrag(block: number, vertex: number, e: PointerEvent, changed: boolean) {
    e.preventDefault();
    e.stopPropagation();
    (this.renderRoot.querySelector('svg') as SVGSVGElement).setPointerCapture(e.pointerId);
    this.drag = { block, vertex, pointerId: e.pointerId, changed };
    this.select({ block, vertex });
    (this.renderRoot.querySelector('svg') as SVGSVGElement).focus();
  }

  private onCornerDown(block: number, vertex: number, e: PointerEvent) {
    this.draft = { blocks: this.blocks };
    this.startDrag(block, vertex, e, false);
  }

  private onEdgeDown(block: number, edge: number, at: Vec2, e: PointerEvent) {
    this.draft = insertVertex({ blocks: this.blocks }, block, edge, at);
    this.startDrag(block, edge + 1, e, true);
  }

  private onMove(e: PointerEvent) {
    const drag = this.drag;
    if (!drag || e.pointerId !== drag.pointerId) return;
    const poly = this.massing.blocks[drag.block]?.polygon ?? [];
    const raw = this.toPlan(e);
    const tolerance = SNAP_FRACTION * Math.max(this.dimensions.width, this.dimensions.depth);
    const p = e.altKey ? raw : snapPoint(poly, drag.vertex, raw, this.dimensions, tolerance);
    const next = moveVertex(this.massing, drag.block, drag.vertex, p, this.dimensions);
    // A position that would make the outline cross itself is skipped: the corner stays put.
    if (next) {
      this.draft = next;
      drag.changed = true;
    }
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const { changed } = this.drag;
    this.drag = null;
    const result = this.draft;
    this.draft = null;
    if (result && changed) this.emit(result);
  }

  private onKey(e: KeyboardEvent) {
    const sel = this.selection;
    if (!sel || sel.vertex === null) return;
    const massing: Massing = { blocks: this.blocks };
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = removeVertex(massing, sel.block, sel.vertex);
      if (next) {
        this.select({ block: sel.block, vertex: null });
        this.emit(next);
      }
      return;
    }
    const step = e.shiftKey ? 1 : 0.1;
    const delta: Record<string, Vec2> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const dv = delta[e.key];
    const p = this.blocks[sel.block]?.polygon[sel.vertex];
    if (!dv || !p) return;
    e.preventDefault();
    const next = moveVertex(massing, sel.block, sel.vertex, [p[0] + dv[0], p[1] + dv[1]], this.dimensions);
    if (next) this.emit(next);
  }

  private renderPhotos() {
    const { W, D, band, gap, o } = this.layout;
    const photo = (f: FacadeId, length: number, transform: string) => {
      const src = this.photos[f];
      return src
        ? svg`<image href=${src} x="0" y="0" width=${length} height=${band} preserveAspectRatio="none" transform=${transform} opacity="0.92" />`
        : svg`<rect x="0" y="0" width=${length} height=${band} transform=${transform} class="no-photo" />`;
    };
    // Each photo's top (the roof line) faces the plan; u runs the way the footprint does.
    return svg`
      ${photo('front', W, `translate(${o} ${o + D + gap})`)}
      ${photo('back', W, `translate(${o + W} ${band}) rotate(180)`)}
      ${photo('right', D, `translate(${o + W + gap} ${o + D}) rotate(-90)`)}
      ${photo('left', D, `translate(${o - gap} ${o}) rotate(90)`)}
      <text x=${o + W / 2} y=${o + D + gap + band * 0.82} class="side">Front</text>
      <text x=${o + W / 2} y=${band * 0.18} class="side">Back</text>
      <text x=${o + W + gap + band * 0.5} y=${o + D + band * 0.18} class="side">Right</text>
      <text x=${band * 0.5} y=${o + D + band * 0.18} class="side">Left</text>
    `;
  }

  private renderGrid() {
    const { W, D, o } = this.layout;
    const lines = [];
    const step = Math.max(W, D) > 60 ? 10 : 5;
    for (let x = step; x < W; x += step) lines.push(svg`<line x1=${o + x} y1=${o} x2=${o + x} y2=${o + D} class="grid" />`);
    for (let d = step; d < D; d += step) lines.push(svg`<line x1=${o} y1=${o + D - d} x2=${o + W} y2=${o + D - d} class="grid" />`);
    return svg`<rect x=${o} y=${o} width=${W} height=${D} class="box" />${lines}`;
  }

  private renderBlocks() {
    const blocks = this.massing.blocks;
    const sel = this.selection;
    const r = 0.012 * Math.max(this.dimensions.width, this.dimensions.depth);
    return blocks.map((b, bi) => {
      const pts = b.polygon.map((p) => this.toSvg(p));
      const selected = sel?.block === bi;
      const [cx, cy] = this.toSvg(polygonCentroid(b.polygon));
      return svg`
        <g class=${selected ? 'block selected' : 'block'}>
          <polygon points=${pts.map((p) => p.join(',')).join(' ')} @pointerdown=${(e: PointerEvent) => {
            e.preventDefault();
            this.select({ block: bi, vertex: null });
          }} />
          <text x=${cx} y=${cy} class="height">${Math.round(b.height * 10) / 10} m</text>
          ${selected
            ? b.polygon.map((p, i) => {
                const q = b.polygon[(i + 1) % b.polygon.length] as Vec2;
                const mid: Vec2 = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
                const [mx, my] = this.toSvg(mid);
                return svg`<circle class="add" cx=${mx} cy=${my} r=${r * 0.7} role="button" aria-label=${`Add a corner on edge ${i + 1}`}
                  @pointerdown=${(e: PointerEvent) => this.onEdgeDown(bi, i, mid, e)} />`;
              })
            : nothing}
          ${b.polygon.map((p, i) => {
            const [x, y] = this.toSvg(p);
            const current = selected && sel?.vertex === i;
            return svg`<circle class=${current ? 'corner current' : 'corner'} cx=${x} cy=${y} r=${selected ? r : r * 0.6}
              role="button" aria-label=${`Corner ${i + 1} of block ${bi + 1}: ${p[0]} m, ${p[1]} m`}
              @pointerdown=${(e: PointerEvent) => this.onCornerDown(bi, i, e)} />`;
          })}
        </g>
      `;
    });
  }

  override render() {
    const { vw, vh } = this.layout;
    return html`<svg viewBox=${`0 0 ${vw} ${vh}`} tabindex="0" role="application" aria-label="Building footprint from above, front at the bottom"
      @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp} @keydown=${this.onKey}
      style=${`--stroke: ${0.004 * Math.max(vw, vh)}px; --font: ${0.03 * Math.max(vw, vh)}px`}>
      ${this.renderPhotos()} ${this.renderGrid()} ${this.renderBlocks()}
    </svg>`;
  }

  static override styles = css`
    :host {
      display: block;
    }
    svg {
      display: block;
      width: 100%;
      max-height: 62vh;
      touch-action: none;
      user-select: none;
      outline: none;
      border-radius: 8px;
      background: #f4f5f2;
    }
    svg:focus-visible {
      box-shadow: 0 0 0 2px #2563eb;
    }
    .no-photo {
      fill: #e3e5e0;
    }
    .side {
      font: 600 calc(var(--font) * 0.75) system-ui, sans-serif;
      fill: #111827;
      paint-order: stroke;
      stroke: rgba(255, 255, 255, 0.85);
      stroke-width: calc(var(--stroke) * 2);
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .box {
      fill: #ffffff;
      stroke: #9ca3af;
      stroke-width: var(--stroke);
      stroke-dasharray: calc(var(--stroke) * 3) calc(var(--stroke) * 3);
    }
    .grid {
      stroke: #e5e7eb;
      stroke-width: var(--stroke);
    }
    .block polygon {
      fill: rgba(37, 99, 235, 0.14);
      stroke: #1d4ed8;
      stroke-width: var(--stroke);
      cursor: pointer;
    }
    .block.selected polygon {
      fill: rgba(37, 99, 235, 0.28);
      stroke-width: calc(var(--stroke) * 1.6);
    }
    .height {
      font: 600 calc(var(--font) * 0.9) system-ui, sans-serif;
      fill: #1e3a8a;
      text-anchor: middle;
      dominant-baseline: middle;
      pointer-events: none;
    }
    .corner {
      fill: #ffffff;
      stroke: #1d4ed8;
      stroke-width: var(--stroke);
      cursor: grab;
    }
    .corner.current {
      fill: #1d4ed8;
    }
    .add {
      fill: rgba(255, 255, 255, 0.8);
      stroke: #1d4ed8;
      stroke-width: calc(var(--stroke) * 0.7);
      stroke-dasharray: calc(var(--stroke) * 1.5) calc(var(--stroke) * 1.5);
      cursor: copy;
    }
  `;
}

if (!customElements.get('abb360-shape-view')) customElements.define('abb360-shape-view', ShapeView);

declare global {
  interface HTMLElementTagNameMap {
    'abb360-shape-view': ShapeView;
  }
}
