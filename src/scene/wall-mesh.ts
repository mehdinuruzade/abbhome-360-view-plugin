import { Mesh, MeshBasicMaterial, PlaneGeometry, type BufferAttribute, type Texture } from 'three';
import { facadeFrame, imageToTextureUv } from '../core/facade-frame';
import { applyH, squareToQuad } from '../core/homography';
import type { Corners, Dimensions, FacadeId } from '../core/types';

/**
 * A wall is a subdivided plane whose vertices carry texture coordinates computed through the
 * corner homography. Straight-on images map exactly; keystoned photos map to within a fraction
 * of a pixel at 16×16 segments. Plain MeshBasicMaterial: the renders already contain their
 * lighting, and three handles the sRGB texture correctly.
 */

export const WALL_SEGMENTS = 16;
export const PLAIN_WALL_COLOR = 0xd8d3cb;

export type WallMesh = Mesh<PlaneGeometry, MeshBasicMaterial>;

/** False (and UVs untouched) when the corners don't form a valid quad. */
export function writeWallUvs(geometry: PlaneGeometry, corners: Corners): boolean {
  const h = squareToQuad(corners);
  if (!h) return false;
  const { widthSegments: gx, heightSegments: gy } = geometry.parameters;
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  // PlaneGeometry lays vertices out row by row from the top-left corner.
  for (let iy = 0; iy <= gy; iy++) {
    for (let ix = 0; ix <= gx; ix++) {
      const [tu, tv] = imageToTextureUv(applyH(h, ix / gx, iy / gy));
      uv.setXY(iy * (gx + 1) + ix, tu, tv);
    }
  }
  uv.needsUpdate = true;
  return true;
}

export function createWall(
  f: FacadeId,
  d: Dimensions,
  corners: Corners,
  map: Texture | null,
  segments = WALL_SEGMENTS,
): WallMesh {
  const frame = facadeFrame(f, d);
  const geometry = new PlaneGeometry(frame.width, frame.height, segments, segments);
  if (map) writeWallUvs(geometry, corners);
  const material = new MeshBasicMaterial(map ? { map } : { color: PLAIN_WALL_COLOR });
  const wall = new Mesh(geometry, material);
  wall.name = `wall-${f}`;
  wall.userData.facade = f;
  wall.rotation.y = frame.rotationY;
  wall.position.set(...frame.center);
  return wall;
}
