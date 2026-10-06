import {
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  TextureLoader,
  WebGLRenderer,
  type Material,
  type Texture,
} from 'three';
import type { Apartment, BuildingConfig, Corners, FacadeId } from '../core/types';
import { FACADES } from '../core/types';
import { CameraRig } from './camera-rig';
import { OverlayLayer, type OverlayState } from './overlays';
import { attachPicker, type PointerPoint } from './picking';
import { createWall, writeWallUvs, type WallMesh } from './wall-mesh';

export interface BuildingSceneOptions {
  reducedMotion?: boolean;
}

/** `pick` and `hover` events carry the apartment id (or null) and the pointer position. */
export type PickEventDetail = PointerPoint & { id: string | null };

const ROOF_COLOR = 0x9da2a7;
const MAX_ANISOTROPY = 8;

function radialTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void, size = 256): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * The 3D building: four photo-textured walls, a roof, a soft ground and the apartment overlays.
 * Renders only when something changes. Owns its canvas and WebGL context; call dispose() to
 * release both.
 */
export class BuildingScene extends EventTarget {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly rig: CameraRig;
  private readonly resizeObserver: ResizeObserver;
  private readonly detachPicker: () => void;
  private readonly textures = new Map<string, Promise<Texture | null>>();
  private walls: Record<FacadeId, WallMesh> | null = null;
  private extras: Mesh[] = [];
  private overlays: OverlayLayer | null = null;
  private overlayState: OverlayState = {};
  private config: BuildingConfig | null = null;
  private inset = { right: 0, bottom: 0 };
  private loadToken = 0;
  private frameRequested = false;
  private rafId = 0;
  private contextLost = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    options: BuildingSceneOptions = {},
  ) {
    super();
    this.canvas = document.createElement('canvas');
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;';
    container.appendChild(this.canvas);
    this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.rig = new CameraRig(this.canvas, container, !!options.reducedMotion);
    this.rig.controls.addEventListener('change', () => this.requestRender());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.detachPicker = attachPicker(this.canvas, this.rig.camera, () => this.overlays?.pickables() ?? [], {
      pick: (id, at) => this.emit('pick', { id, ...at }),
      hover: (id, at) => this.emit('hover', { id, ...at }),
    });
    this.resize();
  }

  /**
   * Shows a building. Resolves once the textures are in and the first frame is drawn. With
   * `keepCamera` (the editor's live preview) the view stays put unless the size changed.
   */
  async load(config: BuildingConfig, opts: { signal?: AbortSignal; keepCamera?: boolean } = {}): Promise<void> {
    const token = ++this.loadToken;
    const maps = await Promise.all(FACADES.map((f) => this.texture(config.facades[f].image, f)));
    // A newer load() started while the textures came in: let that one draw.
    if (opts.signal?.aborted || this.disposed || token !== this.loadToken) return;
    const sizeChanged =
      !this.config || JSON.stringify(this.config.dimensions) !== JSON.stringify(config.dimensions);
    this.config = config;
    this.build(config, maps);
    this.releaseUnusedTextures(config);
    if (!opts.keepCamera || sizeChanged) this.rig.frame(config.dimensions, this.aspect());
    this.renderNow();
  }

  /** Frees GPU memory held for photos the current building no longer uses. */
  private releaseUnusedTextures(config: BuildingConfig): void {
    const used = new Set(FACADES.map((f) => config.facades[f].image));
    for (const [url, texture] of this.textures) {
      if (used.has(url)) continue;
      this.textures.delete(url);
      void texture.then((t) => t?.dispose());
    }
  }

  setOverlayState(state: OverlayState): void {
    this.overlayState = { ...this.overlayState, ...state };
    this.overlays?.setState(this.overlayState);
    this.requestRender();
  }

  updateApartments(apartments: readonly Apartment[]): void {
    if (this.config) this.config = { ...this.config, apartments: [...apartments] };
    this.overlays?.updateApartments(apartments);
    this.requestRender();
  }

  /** Editor live preview: re-maps one wall's texture without reloading anything. */
  setCorners(f: FacadeId, corners: Corners): void {
    const wall = this.walls?.[f];
    if (wall?.material.map && writeWallUvs(wall.geometry, corners)) this.requestRender();
  }

  /**
   * Pixels covered by UI on the right (side panel) or at the bottom (bottom sheet). The picture
   * shifts so the building stays centred in the uncovered part; picking follows automatically.
   */
  setViewInset(inset: { right?: number; bottom?: number }): void {
    const next = { right: Math.max(0, inset.right ?? 0), bottom: Math.max(0, inset.bottom ?? 0) };
    if (next.right === this.inset.right && next.bottom === this.inset.bottom) return;
    this.inset = next;
    this.applyViewOffset();
    this.requestRender();
  }

  flyTo(apartmentId: string, opts: { closeUp?: boolean } = {}): void {
    const focus = this.overlays?.focus(apartmentId);
    if (!focus) return;
    this.rig.flyTo(focus.point, focus.normal, opts);
    this.requestRender();
  }

  /** Back to the opening framing (keeps the direction the user is looking from). */
  overview(): void {
    this.rig.flyHome();
    this.requestRender();
  }

  /**
   * Viewport (client) coordinates of the apartment's largest region facing the camera, or null
   * if none is visible from here.
   */
  screenPosition(apartmentId: string): { x: number; y: number } | null {
    const cam = this.rig.camera;
    cam.updateMatrixWorld();
    const facing = (this.overlays?.anchors(apartmentId) ?? [])
      .filter((a) => a.normal.dot(cam.position.clone().sub(a.point)) > 0)
      .sort((a, b) => b.area - a.area)[0];
    if (!facing) return null;
    const ndc = facing.point.clone().project(cam);
    if (Math.abs(ndc.x) > 1 || Math.abs(ndc.y) > 1 || ndc.z > 1) return null;
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + ((ndc.x + 1) / 2) * rect.width, y: rect.top + ((1 - ndc.y) / 2) * rect.height };
  }

  requestRender(): void {
    if (this.frameRequested || this.disposed || this.contextLost) return;
    this.frameRequested = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  resize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h || this.disposed) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (ratio !== this.renderer.getPixelRatio()) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.rig.resize(w / h);
    this.applyViewOffset();
    this.requestRender();
  }

  private applyViewOffset(): void {
    const cam = this.rig.camera;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const { right, bottom } = this.inset;
    if (!w || !h || (!right && !bottom)) cam.clearViewOffset();
    else cam.setViewOffset(w, h, right / 2, bottom / 2, w, h);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.resizeObserver.disconnect();
    this.detachPicker();
    this.rig.dispose();
    this.clearBuilding();
    for (const p of this.textures.values()) void p.then((t) => t?.dispose());
    this.textures.clear();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private aspect(): number {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    return w && h ? w / h : 4 / 3;
  }

  private emit(type: 'pick' | 'hover', detail: PickEventDetail): void {
    this.dispatchEvent(new CustomEvent<PickEventDetail>(type, { detail }));
  }

  /** Cached by URL; a failed image gives a plain wall rather than failing the whole building. */
  private texture(url: string, facade: FacadeId): Promise<Texture | null> {
    if (!url) return Promise.resolve(null);
    let p = this.textures.get(url);
    if (!p) {
      const loader = new TextureLoader();
      loader.setCrossOrigin('anonymous');
      p = loader.loadAsync(url).then(
        (t) => {
          t.colorSpace = SRGBColorSpace;
          t.anisotropy = Math.min(MAX_ANISOTROPY, this.renderer.capabilities.getMaxAnisotropy());
          return t;
        },
        () => {
          this.dispatchEvent(new CustomEvent('texture-error', { detail: { facade, url } }));
          this.textures.delete(url);
          return null;
        },
      );
      this.textures.set(url, p);
    }
    return p;
  }

  private build(config: BuildingConfig, maps: (Texture | null)[]): void {
    this.clearBuilding();
    const d = config.dimensions;
    const walls = {} as Record<FacadeId, WallMesh>;
    FACADES.forEach((f, i) => {
      walls[f] = createWall(f, d, config.facades[f].corners, maps[i] ?? null);
      this.scene.add(walls[f]);
    });
    this.walls = walls;

    const roof = new Mesh(new PlaneGeometry(d.width, d.depth), new MeshBasicMaterial({ color: ROOF_COLOR }));
    roof.rotation.x = -Math.PI / 2;
    roof.position.y = d.height;

    const reach = Math.max(d.width, d.depth) * 1.8;
    const ground = new Mesh(
      new CircleGeometry(reach, 64),
      new MeshBasicMaterial({
        map: radialTexture((ctx, s) => {
          const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
          g.addColorStop(0, 'rgba(226, 230, 224, 0.95)');
          g.addColorStop(0.55, 'rgba(226, 230, 224, 0.6)');
          g.addColorStop(1, 'rgba(226, 230, 224, 0)');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, s, s);
        }),
        transparent: true,
        depthWrite: false,
      }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;

    const shadow = new Mesh(
      new PlaneGeometry(d.width * 1.5, d.depth * 1.5),
      new MeshBasicMaterial({
        map: radialTexture((ctx, s) => {
          // Draw the rectangle off-canvas and keep only its blurred shadow (works in every browser).
          ctx.shadowColor = 'rgba(30, 36, 44, 0.55)';
          ctx.shadowBlur = s * 0.08;
          ctx.shadowOffsetX = s;
          ctx.fillStyle = '#000';
          ctx.fillRect(s * 0.17 - s, s * 0.17, s * 0.66, s * 0.66);
        }),
        transparent: true,
        depthWrite: false,
      }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = -0.01;

    this.extras = [roof, ground, shadow];
    this.scene.add(roof, ground, shadow);

    this.overlays = new OverlayLayer(walls, d);
    this.overlays.build(config.apartments, config.regions);
    this.overlays.setState(this.overlayState);
  }

  private clearBuilding(): void {
    this.overlays?.dispose();
    this.overlays = null;
    const meshes: Mesh[] = [...(this.walls ? Object.values(this.walls) : []), ...this.extras];
    for (const m of meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      const material = m.material as Material & { map?: Texture | null };
      // Facade textures are cached across rebuilds; generated ones belong to the mesh.
      if (material.map instanceof CanvasTexture) material.map.dispose();
      material.dispose();
    }
    this.walls = null;
    this.extras = [];
  }

  private renderNow(): void {
    if (this.disposed || this.contextLost) return;
    this.renderer.render(this.scene, this.rig.camera);
  }

  private readonly tick = (now: number) => {
    this.frameRequested = false;
    const moving = this.rig.update(now);
    this.renderNow();
    if (moving) this.requestRender();
  };

  private readonly onContextLost = (e: Event) => {
    e.preventDefault();
    this.contextLost = true;
    cancelAnimationFrame(this.rafId);
    this.frameRequested = false;
    this.dispatchEvent(new Event('contextlost'));
  };

  private readonly onContextRestored = () => {
    this.contextLost = false;
    this.dispatchEvent(new Event('contextrestored'));
    this.requestRender();
  };
}
