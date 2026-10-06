import { CanvasTexture, SRGBColorSpace, Vector3 } from 'three';
import { statusColor } from '../core/apartments';
import { reliefAt } from '../core/depth';
import { facadeFrame, facadeWidth, uvToWorld } from '../core/facade-frame';
import type { FacadePoint } from '../core/massing';
import { pointInPolygon, polygonArea, polygonCentroid } from '../core/geometry2d';
import { FACADES, type Apartment, type Dimensions, type FacadeId, type Region } from '../core/types';
import type { WallRelief } from './wall-mesh';

export interface OverlayState {
  hover?: string | null;
  selected?: string | null;
  /** Apartments failing the filter are dimmed and can't be picked. */
  visible?: ((a: Apartment) => boolean) | null;
  /** Tint every apartment by status (true), or only hovered, selected and filtered ones. */
  showAll?: boolean;
}

export interface RegionAnchor {
  facade: FacadeId;
  point: Vector3;
  normal: Vector3;
  /** Square metres. */
  area: number;
}

/** Overlay texture width in pixels; the height follows the wall's proportions. */
const TEXTURE_WIDTH = 768;
const DIMMED_COLOR = '#9aa0a6';
/** Anchors sit just in front of the (possibly displaced) wall surface. */
const ANCHOR_OFFSET = 0.05;

interface WallCanvas {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  texture: CanvasTexture;
}

/**
 * The apartment colours, drawn per wall into a canvas texture in facade space and painted onto
 * the wall by its material. Also answers "which apartment is at (u, v)" for picking, and where
 * an apartment is in 3D for the camera and callouts.
 */
export class OverlayLayer {
  private readonly walls = new Map<FacadeId, WallCanvas>();
  private apartments = new Map<string, Apartment>();
  private regions: Region[] = [];
  private anchorsById = new Map<string, RegionAnchor[]>();
  private state: OverlayState = { showAll: true };

  /**
   * `locate` finds where facade (u, v) is on the building's walls (see massing.facadeToWorld);
   * without it, or where it finds nothing, anchors sit on the bounding box.
   */
  constructor(
    private readonly dims: Dimensions,
    private readonly reliefOf: (f: FacadeId) => WallRelief | null,
    private readonly locate: (f: FacadeId, u: number, v: number) => FacadePoint | null = () => null,
  ) {
    for (const f of FACADES) {
      const canvas = document.createElement('canvas');
      canvas.width = TEXTURE_WIDTH;
      canvas.height = Math.max(64, Math.min(2048, Math.round((TEXTURE_WIDTH * dims.height) / facadeWidth(f, dims))));
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = SRGBColorSpace;
      this.walls.set(f, { canvas, ctx: canvas.getContext('2d'), texture });
    }
  }

  texture(f: FacadeId): CanvasTexture {
    return (this.walls.get(f) as WallCanvas).texture;
  }

  build(apartments: readonly Apartment[], regions: readonly Region[]): void {
    this.apartments = new Map(apartments.map((a) => [a.id, a]));
    this.regions = regions.filter((r) => this.apartments.has(r.apartmentId));
    this.anchorsById.clear();
    for (const r of this.regions) {
      const [cu, cv] = polygonCentroid(r.polygon);
      const relief = this.reliefOf(r.facade);
      const offset = ANCHOR_OFFSET + (relief ? Math.max(0, reliefAt(relief.pixels, cu, cv)) * relief.depthM : 0);
      const onWall = this.locate(r.facade, cu, cv);
      const normal = new Vector3(...(onWall ? onWall.normal : facadeFrame(r.facade, this.dims).normal));
      const anchor: RegionAnchor = {
        facade: r.facade,
        point: onWall
          ? new Vector3(...onWall.point).addScaledVector(normal, offset)
          : new Vector3(...uvToWorld(r.facade, this.dims, cu, cv, offset)),
        normal,
        area: Math.abs(polygonArea(r.polygon)) * facadeWidth(r.facade, this.dims) * this.dims.height,
      };
      const list = this.anchorsById.get(r.apartmentId) ?? [];
      list.push(anchor);
      this.anchorsById.set(r.apartmentId, list);
    }
    this.redraw();
  }

  /** New statuses or prices without recomputing anything else. */
  updateApartments(apartments: readonly Apartment[]): void {
    this.apartments = new Map(apartments.map((a) => [a.id, a]));
    this.redraw();
  }

  setState(next: OverlayState): void {
    const before = this.state;
    this.state = { ...this.state, ...next };
    const s = this.state;
    if (before.hover === s.hover && before.selected === s.selected && before.visible === s.visible && before.showAll === s.showAll) return;
    this.redraw();
  }

  /** The pickable apartment at facade (u, v) on a wall, if any. */
  apartmentAt(f: FacadeId, u: number, v: number): string | null {
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const r = this.regions[i] as Region;
      if (r.facade === f && this.isVisible(r.apartmentId) && pointInPolygon([u, v], r.polygon)) return r.apartmentId;
    }
    return null;
  }

  anchors(id: string): readonly RegionAnchor[] {
    return this.anchorsById.get(id) ?? [];
  }

  /** Where the camera should look for an apartment: area-weighted centre and facing direction. */
  focus(id: string): { point: Vector3; normal: Vector3 } | null {
    const anchors = this.anchors(id);
    if (anchors.length === 0) return null;
    const point = new Vector3();
    const normal = new Vector3();
    let total = 0;
    for (const a of anchors) {
      point.addScaledVector(a.point, a.area);
      normal.addScaledVector(a.normal, a.area);
      total += a.area;
    }
    return { point: point.divideScalar(total || 1), normal: normal.normalize() };
  }

  dispose(): void {
    for (const w of this.walls.values()) w.texture.dispose();
    this.walls.clear();
  }

  private isVisible(id: string): boolean {
    const a = this.apartments.get(id);
    return !!a && (!this.state.visible || this.state.visible(a));
  }

  private redraw(): void {
    const { hover, selected, visible, showAll } = this.state;
    for (const [f, w] of this.walls) {
      const ctx = w.ctx;
      if (!ctx) continue;
      const { width: cw, height: ch } = w.canvas;
      ctx.clearRect(0, 0, cw, ch);
      ctx.lineJoin = 'round';
      for (const r of this.regions) {
        if (r.facade !== f) continue;
        const a = this.apartments.get(r.apartmentId);
        if (!a) continue;
        const matches = !visible || visible(a);
        const isSelected = r.apartmentId === selected;
        const isHover = r.apartmentId === hover;
        let alpha: number;
        if (!matches) {
          // Filtered out: a faint grey when everything is tinted, otherwise not drawn.
          if (!showAll) continue;
          alpha = 0.08;
        } else if (isSelected) alpha = 0.68;
        else if (isHover) alpha = 0.52;
        else if (showAll || visible) alpha = a.status === 'available' || a.status === 'reserved' ? 0.3 : 0.2;
        else continue;
        ctx.beginPath();
        r.polygon.forEach(([u, v], i) => (i === 0 ? ctx.moveTo(u * cw, v * ch) : ctx.lineTo(u * cw, v * ch)));
        ctx.closePath();
        ctx.globalAlpha = alpha;
        ctx.fillStyle = matches ? statusColor(a.status) : DIMMED_COLOR;
        ctx.fill();
        // A thin outline in the wall's own colour separates neighbours; a strong one marks focus.
        ctx.globalAlpha = isSelected || isHover ? 1 : 0.55;
        ctx.strokeStyle = isSelected ? '#ffffff' : matches ? statusColor(a.status) : DIMMED_COLOR;
        ctx.lineWidth = isSelected ? 4 : isHover ? 3 : 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      w.texture.needsUpdate = true;
    }
  }
}
