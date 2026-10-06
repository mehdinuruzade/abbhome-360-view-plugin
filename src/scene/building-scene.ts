import {
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PCFShadowMap,
  PlaneGeometry,
  SRGBColorSpace,
  Scene,
  Shape,
  ShapeGeometry,
  ShadowMaterial,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Material,
  type Texture,
} from 'three';
import type { ReliefPixels } from '../core/depth';
import { applyH, squareToQuad } from '../core/homography';
import { blocksOf, elevationUv, facadeToWorld, occluderHeight, wallsOf, type Block } from '../core/massing';
import { FACADES, type Apartment, type BuildingConfig, type Corners, type FacadeId } from '../core/types';
import { CameraRig } from './camera-rig';
import { OverlayLayer, type OverlayState } from './overlay-texture';
import { attachPicker, type PointerPoint } from './picking';
import { createWall, pickProxy, setWallOverlay, wallsShowing, writeWallUvs, type WallMesh, type WallRelief } from './wall-mesh';

export interface BuildingSceneOptions {
  reducedMotion?: boolean;
}

/** `pick` and `hover` events carry the apartment id (or null) and the pointer position. */
export type PickEventDetail = PointerPoint & { id: string | null };

const ROOF_COLOR = 0x9da2a7;
const PARAPET_COLOR = 0xcfcac2;
const MAX_ANISOTROPY = 8;

/**
 * Lighting. The photos already contain their own light and shade, so the sky light keeps every
 * wall readable, a raking sun brings out relief and casts shadows, and a soft fill from the
 * opposite side keeps the walls the sun never reaches from going dull. Together a wall in full
 * sun lands a little above the photo's own brightness and one in shade a little below.
 * (three's lights are physical: a light of intensity π lights a surface facing it at 100 %.)
 */
const SKY_INTENSITY = Math.PI * 0.62;
const SUN_INTENSITY = Math.PI * 0.62;
const FILL_INTENSITY = Math.PI * 0.22;
/** Sun from the front-left and above, matching the demo renders (front and left walls lit). */
const SUN_DIRECTION = new Vector3(-0.75, 0.6, 0.6).normalize();
/** Fill from the back-right, low and shadowless. */
const FILL_DIRECTION = new Vector3(0.7, 0.3, -0.65).normalize();
const SHADOW_OPACITY = 0.28;

function canvasTexture(draw: (ctx: CanvasRenderingContext2D, size: number) => void, size = 256): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) draw(ctx, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** A relief image's red channel as relief pixels. */
async function loadReliefPixels(url: string): Promise<ReliefPixels | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  try {
    await img.decode();
  } catch {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx || !canvas.width || !canvas.height) return null;
  ctx.drawImage(img, 0, 0);
  const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const data = new Uint8ClampedArray(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = rgba[i * 4] ?? 128;
  return { width: canvas.width, height: canvas.height, data };
}

/**
 * The average colour of the wall inside its corners (linear), for wall parts no photo shows.
 * Null when the image can't be read (a cross-origin image without CORS, say).
 */
function photoTone(texture: Texture, corners: Corners): Color | null {
  const image = texture.image as CanvasImageSource | undefined;
  const h = squareToQuad(corners);
  if (!image || !h) return null;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  try {
    ctx.drawImage(image, 0, 0, size, size);
    const px = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0, n = 0;
    for (let j = 0; j < 12; j++) {
      for (let i = 0; i < 12; i++) {
        const [x, y] = applyH(h, (i + 0.5) / 12, (j + 0.5) / 12);
        const k = (Math.min(size - 1, Math.max(0, Math.floor(y * size))) * size + Math.min(size - 1, Math.max(0, Math.floor(x * size)))) * 4;
        r += px[k] ?? 0;
        g += px[k + 1] ?? 0;
        b += px[k + 2] ?? 0;
        n++;
      }
    }
    return new Color().setRGB(r / n / 255, g / n / 255, b / n / 255, SRGBColorSpace);
  } catch {
    return null;
  }
}

/**
 * The 3D building: its blocks (a box unless the config gives a shape) with photo-textured walls
 * (pushed in and out where a relief map exists), flat roofs with parapets, a ground that takes the
 * building's shadow, and the apartment colours painted on the walls. Renders only when something changes. Owns its canvas and WebGL context;
 * call dispose() to release both.
 */
export class BuildingScene extends EventTarget {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly rig: CameraRig;
  private readonly sun = new DirectionalLight(0xffffff, SUN_INTENSITY);
  private readonly resizeObserver: ResizeObserver;
  private readonly detachPicker: () => void;
  private readonly textures = new Map<string, Promise<Texture | null>>();
  private readonly reliefs = new Map<string, Promise<ReliefPixels | null>>();
  private walls: WallMesh[] = [];
  private blocks: Block[] = [];
  private readonly tones = new Map<string, Color | null>();
  private wallReliefs: Partial<Record<FacadeId, WallRelief>> = {};
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
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;

    this.scene.add(new HemisphereLight(0xffffff, 0xd6d1c7, SKY_INTENSITY));
    const fill = new DirectionalLight(0xffffff, FILL_INTENSITY);
    fill.position.copy(FILL_DIRECTION);
    this.scene.add(fill);
    this.sun.castShadow = true;
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    this.sun.shadow.mapSize.set(small ? 1024 : 2048, small ? 1024 : 2048);
    this.sun.shadow.radius = 3;
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.04;
    this.scene.add(this.sun, this.sun.target);

    this.rig = new CameraRig(this.canvas, container, !!options.reducedMotion);
    this.rig.controls.addEventListener('change', () => this.requestRender());
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.detachPicker = attachPicker(
      this.canvas,
      this.rig.camera,
      () => this.walls.map((w) => pickProxy(w)),
      (hit) => this.apartmentAtHit(hit),
      {
        pick: (id, at) => this.emit('pick', { id, ...at }),
        hover: (id, at) => this.emit('hover', { id, ...at }),
      },
    );
    this.resize();
  }

  /**
   * Shows a building. Resolves once the images are in and the first frame is drawn. With
   * `keepCamera` (the editor's live preview) the view stays put unless the size changed.
   */
  async load(config: BuildingConfig, opts: { signal?: AbortSignal; keepCamera?: boolean } = {}): Promise<void> {
    const token = ++this.loadToken;
    const [maps, reliefs] = await Promise.all([
      Promise.all(FACADES.map((f) => this.texture(config.facades[f].image, f))),
      Promise.all(FACADES.map((f) => this.relief(config.facades[f].relief?.image))),
    ]);
    // A newer load() started while the images came in: let that one draw.
    if (opts.signal?.aborted || this.disposed || token !== this.loadToken) return;
    const sizeChanged =
      !this.config || JSON.stringify(this.config.dimensions) !== JSON.stringify(config.dimensions);
    this.config = config;
    this.build(config, maps, reliefs);
    this.releaseUnused(config);
    if (!opts.keepCamera || sizeChanged) this.rig.frame(config.dimensions, this.aspect());
    this.renderNow();
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

  /** Editor live preview: re-maps one facade's photo on its walls without reloading anything. */
  setCorners(f: FacadeId, corners: Corners): void {
    let changed = false;
    for (const wall of wallsShowing(this.walls, f)) if (wall.material.map && writeWallUvs(wall.geometry, corners)) changed = true;
    if (changed) this.requestRender();
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
    this.reliefs.clear();
    this.tones.clear();
    this.sun.shadow.dispose();
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private applyViewOffset(): void {
    const cam = this.rig.camera;
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const { right, bottom } = this.inset;
    if (!w || !h || (!right && !bottom)) cam.clearViewOffset();
    else cam.setViewOffset(w, h, right / 2, bottom / 2, w, h);
  }

  /**
   * A ray hit on a wall's flat picking surface → facade (u, v) → the apartment drawn there.
   * Nothing where the wall is hidden in its photo (it shows no apartments there).
   */
  private apartmentAtHit(hit: Intersection): string | null {
    const f = hit.object.userData.facade as FacadeId | undefined;
    if (!f || !this.config || !this.overlays) return null;
    const p = hit.point;
    if (p.y <= occluderHeight(f, [p.x, p.z], this.blocks) + 1e-3) return null;
    const [u, v] = elevationUv(f, [p.x, p.y, p.z], this.config.dimensions);
    return this.overlays.apartmentAt(f, u, v);
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

  /** Cached by URL; a relief that fails to load leaves the wall flat. */
  private relief(url: string | undefined): Promise<ReliefPixels | null> {
    if (!url) return Promise.resolve(null);
    let p = this.reliefs.get(url);
    if (!p) {
      p = loadReliefPixels(url);
      this.reliefs.set(url, p);
    }
    return p;
  }

  /** Frees memory held for photos and reliefs the current building no longer uses. */
  private releaseUnused(config: BuildingConfig): void {
    const photos = new Set(FACADES.map((f) => config.facades[f].image));
    for (const [url, texture] of this.textures) {
      if (photos.has(url)) continue;
      this.textures.delete(url);
      void texture.then((t) => t?.dispose());
    }
    this.tones.clear();
    const reliefs = new Set(FACADES.map((f) => config.facades[f].relief?.image));
    for (const url of this.reliefs.keys()) if (!reliefs.has(url)) this.reliefs.delete(url);
  }

  /** The photo's wall tone for these corners, cached. */
  private tone(map: Texture, corners: Corners): Color | null {
    const key = `${map.uuid}:${JSON.stringify(corners)}`;
    if (!this.tones.has(key)) this.tones.set(key, photoTone(map, corners));
    return this.tones.get(key) ?? null;
  }

  private build(config: BuildingConfig, maps: (Texture | null)[], reliefs: (ReliefPixels | null)[]): void {
    this.clearBuilding();
    const d = config.dimensions;
    this.wallReliefs = {};
    FACADES.forEach((f, i) => {
      const pixels = reliefs[i];
      const depthM = config.facades[f].relief?.depthM ?? 0;
      if (pixels && depthM > 0) this.wallReliefs[f] = { pixels, depthM };
    });
    const blocks = blocksOf(config);
    const shapes = wallsOf(blocks);
    this.blocks = blocks;

    this.overlays = new OverlayLayer(
      d,
      (f) => this.wallReliefs[f] ?? null,
      (f, u, v) => facadeToWorld(f, u, v, shapes, blocks, d),
    );
    const small = Math.min(window.innerWidth, window.innerHeight) < 600;
    this.walls = shapes.map((shape, i) => {
      const f = shape.facade;
      const k = FACADES.indexOf(f);
      const map = maps[k] ?? null;
      const corners = config.facades[f].corners;
      const wall = createWall(shape, i, d, blocks, { map, corners, relief: this.wallReliefs[f] ?? null, tone: map ? this.tone(map, corners) : null }, small ? 0.6 : 1);
      setWallOverlay(wall, (this.overlays as OverlayLayer).texture(f));
      this.scene.add(wall);
      return wall;
    });
    this.overlays.build(config.apartments, config.regions);
    this.overlays.setState(this.overlayState);

    // Each block's roof just below a parapet rim, so the top edge has thickness.
    const parapetH = 0.45;
    const parapetT = 0.3;
    const roofMaterial = new MeshStandardMaterial({ color: ROOF_COLOR, roughness: 1 });
    const parapetMaterial = new MeshStandardMaterial({ color: PARAPET_COLOR, roughness: 1 });
    const roofs: Mesh[] = blocks.map((b) => {
      // ShapeGeometry lies in X-Y; rotating it flat maps (X, Y) to (X, −Z), hence the −Z here.
      const roof = new Mesh(new ShapeGeometry(new Shape(b.points.map(([x, z]) => new Vector2(x, -z)))), roofMaterial);
      roof.rotation.x = -Math.PI / 2;
      roof.position.y = b.height - 0.05;
      roof.receiveShadow = true;
      return roof;
    });
    const rims: Mesh[] = shapes.map((w) => {
      const rim = new Mesh(new BoxGeometry(w.length + parapetT, parapetH, parapetT), parapetMaterial);
      const [ax, az] = w.a;
      const [bx, bz] = w.b;
      // Centred on the wall, just inside it, turned to run along it.
      rim.position.set((ax + bx) / 2 - (w.normal[0] * parapetT) / 2, w.height + parapetH / 2 - 0.05, (az + bz) / 2 - (w.normal[1] * parapetT) / 2);
      rim.rotation.y = Math.atan2(-(bz - az), bx - ax);
      rim.castShadow = true;
      rim.receiveShadow = true;
      return rim;
    });

    const reach = Math.max(d.width, d.depth) * 1.8;
    const ground = new Mesh(
      new CircleGeometry(reach, 64),
      new MeshBasicMaterial({
        map: canvasTexture((ctx, s) => {
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
    ground.position.y = -0.03;

    // Soft contact darkening right around the base (ambient occlusion, not a cast shadow).
    const spanX = d.width * 1.3;
    const spanZ = d.depth * 1.3;
    const contact = new Mesh(
      new PlaneGeometry(spanX, spanZ),
      new MeshBasicMaterial({
        map: canvasTexture((ctx, s) => {
          // Draw the footprint off-canvas and keep only its blurred shadow (works in every browser).
          ctx.shadowColor = 'rgba(30, 36, 44, 0.5)';
          ctx.shadowBlur = s * 0.05;
          ctx.shadowOffsetX = s;
          ctx.fillStyle = '#000';
          for (const b of blocks) {
            ctx.beginPath();
            b.points.forEach(([x, z], i) => {
              // The plane's texture top is −Z (the back) once it is laid flat.
              const cx = (x / spanX + 0.5) * s - s;
              const cy = (z / spanZ + 0.5) * s;
              if (i === 0) ctx.moveTo(cx, cy);
              else ctx.lineTo(cx, cy);
            });
            ctx.closePath();
            ctx.fill();
          }
        }),
        transparent: true,
        depthWrite: false,
      }),
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = -0.02;

    // The sun's real shadow on the ground.
    const shadowCatcher = new Mesh(new PlaneGeometry(reach * 2, reach * 2), new ShadowMaterial({ opacity: SHADOW_OPACITY }));
    shadowCatcher.rotation.x = -Math.PI / 2;
    shadowCatcher.position.y = -0.01;
    shadowCatcher.receiveShadow = true;

    this.extras = [...roofs, ...rims, ground, contact, shadowCatcher];
    this.scene.add(...this.extras);
    this.placeSun(config);
  }

  /** Aims the sun at the building and fits its shadow camera around it. */
  private placeSun(config: BuildingConfig): void {
    const { width, depth, height } = config.dimensions;
    const radius = 0.5 * Math.hypot(width, depth, height) + 2;
    const target = new Vector3(0, height / 2, 0);
    this.sun.target.position.copy(target);
    this.sun.position.copy(target).addScaledVector(SUN_DIRECTION, radius * 3);
    const cam = this.sun.shadow.camera;
    // The ground shadow stretches away from the sun; leave room for it.
    const reach = radius * 2.2;
    cam.left = -reach;
    cam.right = reach;
    cam.top = reach;
    cam.bottom = -reach;
    cam.near = radius;
    cam.far = radius * 6;
    cam.updateProjectionMatrix();
    this.sun.target.updateMatrixWorld();
  }

  private clearBuilding(): void {
    this.overlays?.dispose();
    this.overlays = null;
    const meshes: Mesh[] = [...this.walls, ...this.extras];
    const materials = new Set<Material>();
    for (const m of meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      for (const child of m.children) if (child instanceof Mesh) {
        child.geometry.dispose();
        (child.material as Material).dispose();
      }
      materials.add(m.material as Material);
    }
    for (const material of materials) {
      const withMap = material as Material & { map?: Texture | null };
      // Facade photos are cached across rebuilds; generated textures belong to the mesh.
      if (withMap.map instanceof CanvasTexture) withMap.map.dispose();
      (material as Material & { bumpMap?: Texture | null }).bumpMap?.dispose();
      const overlay = material.userData.overlay as { value?: Texture } | undefined;
      if (overlay?.value && !(overlay.value instanceof CanvasTexture)) overlay.value.dispose();
      material.dispose();
    }
    this.walls = [];
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
