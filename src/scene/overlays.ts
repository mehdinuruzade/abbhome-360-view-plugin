import {
  BufferGeometry,
  Float32BufferAttribute,
  FrontSide,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { statusColor } from '../core/apartments';
import { facadeFrame, facadeWidth, uvToLocal, uvToWorld } from '../core/facade-frame';
import { polygonArea, polygonCentroid } from '../core/geometry2d';
import type { Apartment, Dimensions, FacadeId, Region, Vec2 } from '../core/types';
import type { WallMesh } from './wall-mesh';

/** Overlays float this far off the wall (plus polygonOffset) so they never z-fight. */
export const OVERLAY_OFFSET = 0.06;
/** Each outline is pulled in this far (metres) so neighbouring apartments read as separate. */
const INSET = 0.09;
const DIMMED_COLOR = '#9aa0a6';

export interface OverlayState {
  hover?: string | null;
  selected?: string | null;
  /** Apartments failing the filter are dimmed and can't be picked. */
  visible?: ((a: Apartment) => boolean) | null;
}

export interface RegionAnchor {
  facade: FacadeId;
  point: Vector3;
  normal: Vector3;
  /** Square metres. */
  area: number;
}

interface Visual {
  fill: MeshBasicMaterial;
  line: LineBasicMaterial;
  meshes: Mesh[];
  lines: LineLoop[];
  anchors: RegionAnchor[];
}

function insetPoints(points: Vec2[]): Vec2[] {
  const [cx, cy] = polygonCentroid(points);
  return points.map(([x, y]): Vec2 => [x + Math.sign(cx - x) * INSET, y + Math.sign(cy - y) * INSET]);
}

export class OverlayLayer {
  private readonly visuals = new Map<string, Visual>();
  private apartments = new Map<string, Apartment>();
  private state: OverlayState = {};

  constructor(
    private readonly walls: Readonly<Record<FacadeId, WallMesh>>,
    private readonly dims: Dimensions,
  ) {}

  build(apartments: readonly Apartment[], regions: readonly Region[]): void {
    this.clear();
    this.apartments = new Map(apartments.map((a) => [a.id, a]));
    for (const r of regions) {
      if (!this.apartments.has(r.apartmentId)) continue;
      const visual = this.visualFor(r.apartmentId);
      const local = insetPoints(r.polygon.map(([u, v]) => uvToLocal(r.facade, this.dims, u, v)));
      const wall = this.walls[r.facade];

      const mesh = new Mesh(new ShapeGeometry(new Shape(local.map(([x, y]) => new Vector2(x, y)))), visual.fill);
      mesh.position.z = OVERLAY_OFFSET;
      mesh.renderOrder = 1;
      mesh.userData.apartmentId = r.apartmentId;
      wall.add(mesh);
      visual.meshes.push(mesh);

      const lineGeometry = new BufferGeometry();
      lineGeometry.setAttribute('position', new Float32BufferAttribute(local.flatMap(([x, y]) => [x, y, 0]), 3));
      const line = new LineLoop(lineGeometry, visual.line);
      line.position.z = OVERLAY_OFFSET + 0.01;
      line.renderOrder = 2;
      wall.add(line);
      visual.lines.push(line);

      const [cu, cv] = polygonCentroid(r.polygon);
      const area = Math.abs(polygonArea(r.polygon)) * facadeWidth(r.facade, this.dims) * this.dims.height;
      visual.anchors.push({
        facade: r.facade,
        point: new Vector3(...uvToWorld(r.facade, this.dims, cu, cv, OVERLAY_OFFSET)),
        normal: new Vector3(...facadeFrame(r.facade, this.dims).normal),
        area,
      });
    }
    this.apply();
  }

  /** New statuses or prices without rebuilding geometry. */
  updateApartments(apartments: readonly Apartment[]): void {
    this.apartments = new Map(apartments.map((a) => [a.id, a]));
    this.apply();
  }

  setState(next: OverlayState): void {
    this.state = { ...this.state, ...next };
    this.apply();
  }

  pickables(): Mesh[] {
    const out: Mesh[] = [];
    for (const [id, v] of this.visuals) if (this.isVisible(id)) out.push(...v.meshes);
    return out;
  }

  anchors(id: string): readonly RegionAnchor[] {
    return this.visuals.get(id)?.anchors ?? [];
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
    this.clear();
  }

  private isVisible(id: string): boolean {
    const a = this.apartments.get(id);
    return !!a && (!this.state.visible || this.state.visible(a));
  }

  private visualFor(id: string): Visual {
    let v = this.visuals.get(id);
    if (!v) {
      v = {
        fill: new MeshBasicMaterial({
          transparent: true,
          depthWrite: false,
          side: FrontSide,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
        line: new LineBasicMaterial({ transparent: true, depthWrite: false }),
        meshes: [],
        lines: [],
        anchors: [],
      };
      this.visuals.set(id, v);
    }
    return v;
  }

  private apply(): void {
    for (const [id, v] of this.visuals) {
      const a = this.apartments.get(id);
      if (!a) continue;
      const visible = this.isVisible(id);
      const selected = id === this.state.selected;
      const hover = id === this.state.hover;
      const color = statusColor(a.status);
      const base = a.status === 'available' || a.status === 'reserved' ? 0.27 : 0.17;
      v.fill.color.set(visible ? color : DIMMED_COLOR);
      v.fill.opacity = !visible ? 0.06 : selected ? 0.66 : hover ? 0.5 : base;
      v.line.color.set(selected ? '#ffffff' : color);
      v.line.opacity = selected ? 1 : 0.9;
      for (const line of v.lines) line.visible = visible && (selected || hover);
    }
  }

  private clear(): void {
    for (const v of this.visuals.values()) {
      for (const m of v.meshes) {
        m.removeFromParent();
        m.geometry.dispose();
      }
      for (const l of v.lines) {
        l.removeFromParent();
        l.geometry.dispose();
      }
      v.fill.dispose();
      v.line.dispose();
    }
    this.visuals.clear();
  }
}
