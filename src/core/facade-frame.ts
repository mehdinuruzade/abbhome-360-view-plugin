import type { Dimensions, FacadeId, Vec2, Vec3 } from './types';

/**
 * World: Y up, metres, origin at the centre of the footprint on the ground.
 * Facade space: u to the right and v down, as seen by someone outside facing that wall.
 *
 *   front  z = +depth/2   normal +Z   u along +X
 *   right  x = +width/2   normal +X   u along −Z
 *   back   z = −depth/2   normal −Z   u along −X
 *   left   x = −width/2   normal −X   u along +Z
 *
 * Each wall is a plane rotated about Y (never scaled negatively), so walking front → right →
 * back → left keeps the outside on your left and every wall's right edge meets the next wall's
 * left edge.
 */

export const NEXT: Readonly<Record<FacadeId, FacadeId>> = {
  front: 'right',
  right: 'back',
  back: 'left',
  left: 'front',
};

const ROTATION_Y: Readonly<Record<FacadeId, number>> = {
  front: 0,
  right: Math.PI / 2,
  back: Math.PI,
  left: -Math.PI / 2,
};

export interface FacadeFrame {
  rotationY: number;
  center: Vec3;
  normal: Vec3;
  width: number;
  height: number;
}

/** Drops floating-point dust (cos(π/2) ≈ 6e-17) so frames compare exactly. */
function clean(n: number): number {
  return Math.abs(n) < 1e-12 ? 0 : n;
}

export function facadeWidth(f: FacadeId, d: Dimensions): number {
  return f === 'front' || f === 'back' ? d.width : d.depth;
}

export function facadeFrame(f: FacadeId, d: Dimensions): FacadeFrame {
  const rotationY = ROTATION_Y[f];
  const normal: Vec3 = [clean(Math.sin(rotationY)), 0, clean(Math.cos(rotationY))];
  const halfOut = (f === 'front' || f === 'back' ? d.depth : d.width) / 2;
  return {
    rotationY,
    center: [clean(normal[0] * halfOut), d.height / 2, clean(normal[2] * halfOut)],
    normal,
    width: facadeWidth(f, d),
    height: d.height,
  };
}

/** Facade (u, v) to the wall's own plane: origin at its centre, x right, y up, metres. */
export function uvToLocal(f: FacadeId, d: Dimensions, u: number, v: number): Vec2 {
  return [(u - 0.5) * facadeWidth(f, d), (0.5 - v) * d.height];
}

export function localToUv(f: FacadeId, d: Dimensions, x: number, y: number): Vec2 {
  return [x / facadeWidth(f, d) + 0.5, 0.5 - y / d.height];
}

/** Facade (u, v) to world coordinates, `offset` metres out along the wall's normal. */
export function uvToWorld(f: FacadeId, d: Dimensions, u: number, v: number, offset = 0): Vec3 {
  const frame = facadeFrame(f, d);
  const [x, y] = uvToLocal(f, d, u, v);
  const cos = Math.cos(frame.rotationY);
  const sin = Math.sin(frame.rotationY);
  return [
    clean(frame.center[0] + x * cos + offset * sin),
    frame.center[1] + y,
    clean(frame.center[2] - x * sin + offset * cos),
  ];
}

/**
 * Normalised image position (y down) to texture UV (y up, as three.js samples an image loaded
 * with `flipY`). This is the only place the image's y axis is flipped.
 */
export function imageToTextureUv(p: Vec2): Vec2 {
  return [p[0], 1 - p[1]];
}
