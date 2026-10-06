import { LitElement, css, html, nothing, svg } from 'lit';
import { isConvexQuad } from '../core/homography';
import type { Corners, Vec2 } from '../core/types';

export interface CornersChangeDetail {
  corners: Corners;
  /** False while dragging, true on release. */
  final: boolean;
  valid: boolean;
}

const KEYS = ['tl', 'tr', 'br', 'bl'] as const;
const LABELS: Record<(typeof KEYS)[number], string> = {
  tl: 'Top-left corner',
  tr: 'Top-right corner',
  br: 'Bottom-right corner',
  bl: 'Bottom-left corner',
};

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** A facade photo with four draggable corner handles (also movable with the arrow keys). */
export class CornerView extends LitElement {
  static override properties = {
    src: { type: String },
    corners: { attribute: false },
  };

  declare src: string;
  declare corners: Corners;
  private drag: { key: (typeof KEYS)[number]; pointerId: number } | null = null;

  constructor() {
    super();
    this.src = '';
    this.corners = { tl: [0, 0], tr: [1, 0], br: [1, 1], bl: [0, 1] };
  }

  private toImage(e: PointerEvent): Vec2 {
    const rect = this.renderRoot.querySelector('.frame')?.getBoundingClientRect();
    if (!rect || !rect.width) return [0, 0];
    return [clamp01((e.clientX - rect.left) / rect.width), clamp01((e.clientY - rect.top) / rect.height)];
  }

  private emit(corners: Corners, final: boolean) {
    this.dispatchEvent(
      new CustomEvent<CornersChangeDetail>('corners-change', {
        detail: { corners, final, valid: isConvexQuad(corners) },
        bubbles: true,
        composed: true,
      }),
    );
  }

  private onDown(key: (typeof KEYS)[number], e: PointerEvent) {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    this.drag = { key, pointerId: e.pointerId };
  }

  private onMove(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.corners = { ...this.corners, [this.drag.key]: this.toImage(e) };
    this.emit(this.corners, false);
  }

  private onUp(e: PointerEvent) {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    this.drag = null;
    this.emit(this.corners, true);
  }

  private onKey(key: (typeof KEYS)[number], e: KeyboardEvent) {
    const step = e.shiftKey ? 0.01 : 0.001;
    const delta: Record<string, Vec2> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const p = this.corners[key];
    this.corners = { ...this.corners, [key]: [clamp01(p[0] + d[0]), clamp01(p[1] + d[1])] };
    this.emit(this.corners, true);
  }

  protected override render() {
    if (!this.src) return html`<p class="empty">Add this wall's photo first.</p>`;
    const c = this.corners;
    const points = KEYS.map((k) => c[k].join(',')).join(' ');
    const valid = isConvexQuad(c);
    return html`
      <div class="frame" @pointermove=${this.onMove} @pointerup=${this.onUp} @pointercancel=${this.onUp}>
        <img src=${this.src} alt="" draggable="false" />
        <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden="true">
          ${svg`<polygon points=${points} class=${valid ? 'quad' : 'quad bad'} />`}
        </svg>
        ${KEYS.map(
          (k) => html`<button
            class="handle"
            type="button"
            style="left:${c[k][0] * 100}%;top:${c[k][1] * 100}%"
            aria-label=${LABELS[k]}
            @pointerdown=${(e: PointerEvent) => this.onDown(k, e)}
            @keydown=${(e: KeyboardEvent) => this.onKey(k, e)}
          ></button>`,
        )}
      </div>
      ${valid ? nothing : html`<p class="error" role="alert">The corners cross over. Keep them in order: top-left, top-right, bottom-right, bottom-left.</p>`}
    `;
  }

  static override styles = css`
    :host {
      display: block;
    }
    .frame {
      position: relative;
      width: fit-content;
      max-width: 100%;
      margin: 0 auto;
      touch-action: none;
      user-select: none;
    }
    img {
      display: block;
      max-width: 100%;
      max-height: 68vh;
    }
    svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
    .quad {
      fill: rgb(47 158 91 / 0.05);
      stroke: #2f9e5b;
      stroke-width: 2;
      vector-effect: non-scaling-stroke;
    }
    .quad.bad {
      fill: rgb(214 69 65 / 0.12);
      stroke: #d64541;
    }
    .handle {
      position: absolute;
      width: 22px;
      height: 22px;
      margin: -11px 0 0 -11px;
      padding: 0;
      border: 2px solid #fff;
      border-radius: 50%;
      background: #2f9e5b;
      box-shadow: 0 1px 4px rgb(0 0 0 / 0.4);
      cursor: grab;
      touch-action: none;
    }
    .handle:focus-visible {
      outline: 3px solid #1d2733;
      outline-offset: 2px;
    }
    .empty,
    .error {
      margin: 12px 0 0;
      color: #5b6673;
    }
    .error {
      color: #b3261e;
    }
  `;
}

if (!customElements.get('abb360-corner-view')) customElements.define('abb360-corner-view', CornerView);
