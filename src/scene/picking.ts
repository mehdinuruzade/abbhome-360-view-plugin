import { Raycaster, Vector2, type Camera, type Object3D } from 'three';

export interface PointerPoint {
  x: number;
  y: number;
}

export interface PickerHandlers {
  pick(id: string | null, at: PointerPoint): void;
  hover(id: string | null, at: PointerPoint): void;
}

/** A press that moves further than this is a drag (orbit), not a tap. */
const TAP_SLOP_PX = 6;
/** A tap that misses snaps to an apartment within this distance. */
const SNAP_RINGS_PX = [8, 16];
const SNAP_DIRECTIONS = 8;

/**
 * Taps and mouse hover over apartment overlays. Uses pointer-down/up distance rather than the
 * click event, so finishing an orbit drag never selects anything.
 */
export function attachPicker(
  canvas: HTMLCanvasElement,
  camera: Camera,
  targets: () => Object3D[],
  on: PickerHandlers,
): () => void {
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  let down: { id: number; x: number; y: number } | null = null;
  const pointers = new Set<number>();
  let hoverFrame = 0;
  let lastHover: string | null = null;

  const hitAt = (x: number, y: number): string | null => {
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    ndc.set(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(targets(), false)[0];
    return (hit?.object.userData.apartmentId as string | undefined) ?? null;
  };

  const hitNear = (x: number, y: number): string | null => {
    const direct = hitAt(x, y);
    if (direct) return direct;
    for (const r of SNAP_RINGS_PX) {
      for (let k = 0; k < SNAP_DIRECTIONS; k++) {
        const angle = (k / SNAP_DIRECTIONS) * Math.PI * 2;
        const id = hitAt(x + r * Math.cos(angle), y + r * Math.sin(angle));
        if (id) return id;
      }
    }
    return null;
  };

  const onDown = (e: PointerEvent) => {
    // A primary pointer starts a fresh gesture; drop anything stale.
    if (e.isPrimary) pointers.clear();
    pointers.add(e.pointerId);
    // A second finger makes it a pinch, even if the first one hasn't moved.
    if (pointers.size > 1) {
      down = null;
      return;
    }
    if (e.button !== 0 || !e.isPrimary) return;
    down = { id: e.pointerId, x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (!down || down.id !== e.pointerId) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved <= TAP_SLOP_PX) on.pick(hitNear(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
  };
  const onCancel = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    down = null;
  };
  const onLostCapture = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.buttons !== 0) return;
    const { clientX: x, clientY: y } = e;
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => {
      const id = hitAt(x, y);
      if (id !== lastHover || id) {
        lastHover = id;
        on.hover(id, { x, y });
      }
    });
  };
  const onLeave = () => {
    cancelAnimationFrame(hoverFrame);
    if (lastHover !== null) {
      lastHover = null;
      on.hover(null, { x: 0, y: 0 });
    }
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onCancel);
  canvas.addEventListener('lostpointercapture', onLostCapture);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  return () => {
    cancelAnimationFrame(hoverFrame);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onCancel);
    canvas.removeEventListener('lostpointercapture', onLostCapture);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
  };
}
