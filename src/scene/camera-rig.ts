import { MathUtils, PerspectiveCamera, Spherical, TOUCH, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Dimensions } from '../core/types';

/** Polar angle from straight up: 60° keeps the camera at most 30° above the horizon, 92° just below. */
export const MIN_POLAR = MathUtils.degToRad(60);
export const MAX_POLAR = MathUtils.degToRad(92);
/** Opening view: three-quarters onto the front and left walls (the sunlit ones in the demo). */
export const DEFAULT_AZIMUTH = MathUtils.degToRad(-35);
export const DEFAULT_POLAR = MathUtils.degToRad(80);
const FOCUS_POLAR = MathUtils.degToRad(84);
const FOV = 35;
const FLIGHT_MS = 700;

interface Pose {
  target: Vector3;
  spherical: Spherical;
}

const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Orbit camera tuned for a widget living inside someone else's page:
 * - a plain mouse wheel scrolls the page; Ctrl/⌘ + wheel or a trackpad pinch zooms;
 * - `touch-action: pan-y` lets vertical swipes scroll the page while horizontal drags rotate;
 * - two fingers dolly and rotate, and there is no panning, so the building can't be lost.
 */
export class CameraRig {
  readonly camera = new PerspectiveCamera(FOV, 1, 0.5, 4000);
  readonly controls: OrbitControls;
  private dims: Dimensions | null = null;
  private fit = 100;
  private flight: { from: Pose; to: Pose; start: number } | null = null;
  private readonly removeWheelFilter: () => void;

  constructor(
    canvas: HTMLCanvasElement,
    wheelHost: HTMLElement,
    private readonly reducedMotion: boolean,
  ) {
    const c = new OrbitControls(this.camera, canvas);
    c.enablePan = false;
    c.enableDamping = true;
    c.dampingFactor = 0.08;
    c.rotateSpeed = 0.6;
    c.zoomSpeed = 0.8;
    c.minPolarAngle = MIN_POLAR;
    c.maxPolarAngle = MAX_POLAR;
    c.touches = { ONE: TOUCH.ROTATE, TWO: TOUCH.DOLLY_ROTATE };
    c.addEventListener('start', () => {
      this.flight = null;
    });
    // OrbitControls sets touch-action: none; restore vertical page scrolling.
    canvas.style.touchAction = 'pan-y';
    // Zoom only with Ctrl/⌘ (trackpad pinches arrive as ctrl + wheel). For a plain wheel,
    // OrbitControls returns without preventDefault, so the page scrolls and the host page
    // still receives the event. The flag goes back on after OrbitControls has seen the event.
    const beforeControls = (e: WheelEvent) => {
      c.enableZoom = e.ctrlKey || e.metaKey;
    };
    const afterControls = () => {
      c.enableZoom = true;
    };
    wheelHost.addEventListener('wheel', beforeControls, { capture: true, passive: true });
    canvas.addEventListener('wheel', afterControls, { passive: true });
    this.removeWheelFilter = () => {
      wheelHost.removeEventListener('wheel', beforeControls, { capture: true });
      canvas.removeEventListener('wheel', afterControls);
    };
    this.controls = c;
  }

  /** Points the camera at a newly loaded building from the default three-quarter view. */
  frame(dims: Dimensions, aspect: number): void {
    this.dims = dims;
    this.flight = null;
    this.resize(aspect);
    this.controls.target.set(0, dims.height * 0.45, 0);
    const offset = new Vector3().setFromSpherical(new Spherical(this.fit, DEFAULT_POLAR, DEFAULT_AZIMUTH));
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  /** Keeps distance limits right for the new aspect ratio; doesn't move the camera. */
  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (!this.dims) return;
    const { width, depth, height } = this.dims;
    const radius = 0.5 * Math.hypot(width, depth, height);
    const vFov = MathUtils.degToRad(FOV);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
    // The bounding sphere is generous; portrait views can afford a tighter fit.
    const margin = aspect < 1 ? 0.92 : 1.05;
    this.fit = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * margin;
    this.controls.minDistance = this.fit * 0.3;
    this.controls.maxDistance = this.fit * 1.5;
  }

  /**
   * Turns to face a point on the building (an apartment). The orbit stays centred on the
   * building's axis. By default it leans towards the apartment's height and keeps the whole
   * building in view; `closeUp` (small screens, where a bottom sheet covers most of the view)
   * comes in close at the apartment's height instead.
   */
  flyTo(point: Vector3, normal: Vector3, opts: { closeUp?: boolean } = {}, now = performance.now()): void {
    if (!this.dims) return;
    const h = this.dims.height;
    const current = this.camera.position.distanceTo(this.controls.target);
    const targetY = opts.closeUp
      ? MathUtils.clamp(point.y, h * 0.05, h * 0.95)
      : MathUtils.clamp((point.y + h * 0.45) / 2, h * 0.25, h * 0.75);
    const distance = opts.closeUp
      ? Math.max(this.controls.minDistance, this.fit * 0.5)
      : MathUtils.clamp(current, this.controls.minDistance, this.fit * 0.95);
    this.startFlight(
      { target: new Vector3(0, targetY, 0), spherical: new Spherical(distance, FOCUS_POLAR, Math.atan2(normal.x, normal.z)) },
      now,
    );
  }

  /** Back to the opening framing, keeping the current direction. */
  flyHome(now = performance.now()): void {
    if (!this.dims) return;
    const theta = new Spherical().setFromVector3(this.camera.position.clone().sub(this.controls.target)).theta;
    this.startFlight(
      { target: new Vector3(0, this.dims.height * 0.45, 0), spherical: new Spherical(this.fit, DEFAULT_POLAR, theta) },
      now,
    );
  }

  private startFlight(to: Pose, now: number): void {
    if (this.reducedMotion) {
      this.flight = null;
      this.apply(to);
      return;
    }
    const offset = this.camera.position.clone().sub(this.controls.target);
    const from: Pose = { target: this.controls.target.clone(), spherical: new Spherical().setFromVector3(offset) };
    // Turn the short way round.
    const dTheta = to.spherical.theta - from.spherical.theta;
    to.spherical.theta = from.spherical.theta + Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    this.flight = { from, to, start: now };
  }

  /** Advances any flight and damping. True while the camera is still moving. */
  update(now: number): boolean {
    if (this.flight) {
      const t = Math.min(1, (now - this.flight.start) / FLIGHT_MS);
      const k = easeInOutCubic(t);
      const { from, to } = this.flight;
      this.apply({
        target: from.target.clone().lerp(to.target, k),
        spherical: new Spherical(
          MathUtils.lerp(from.spherical.radius, to.spherical.radius, k),
          MathUtils.lerp(from.spherical.phi, to.spherical.phi, k),
          MathUtils.lerp(from.spherical.theta, to.spherical.theta, k),
        ),
      });
      if (t >= 1) this.flight = null;
      return true;
    }
    return this.controls.update();
  }

  dispose(): void {
    this.removeWheelFilter();
    this.controls.dispose();
  }

  private apply(pose: Pose): void {
    this.controls.target.copy(pose.target);
    this.camera.position.copy(pose.target).add(new Vector3().setFromSpherical(pose.spherical));
    this.camera.lookAt(pose.target);
    this.controls.update();
  }
}
