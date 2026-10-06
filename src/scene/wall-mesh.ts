import {
  BufferAttribute,
  DataTexture,
  FrontSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  RedFormat,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { reliefAt, type ReliefPixels } from '../core/depth';
import { facadeFrame, imageToTextureUv } from '../core/facade-frame';
import { applyH, squareToQuad } from '../core/homography';
import type { Corners, Dimensions, FacadeId } from '../core/types';

/**
 * A wall is a subdivided plane whose vertices carry texture coordinates computed through the
 * corner homography (exact for straight-on images, a fraction of a pixel off at 16×16 segments
 * for keystoned ones). With a relief map, a denser plane is pushed in and out along the wall's
 * normal and its normals recomputed, so light and shadow show the depth.
 *
 * The apartment colours are painted on the wall itself: a per-wall overlay texture in facade
 * space, mixed into the albedo by a small shader hook, so they follow the displaced surface.
 */

export const WALL_SEGMENTS = 16;
const RELIEF_SEGMENTS_U = 224;
export const PLAIN_WALL_COLOR = 0xd8d3cb;

export interface WallRelief {
  pixels: ReliefPixels;
  depthM: number;
}

export type WallMesh = Mesh<PlaneGeometry, MeshStandardMaterial>;

/** A transparent 1×1 texture, so the overlay sampler always has something valid bound. */
function transparentTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

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

/** Facade (u, v) per vertex, stored flipped (v up) to match how three samples canvas textures. */
function writeFacadeUvs(geometry: PlaneGeometry): void {
  const { widthSegments: gx, heightSegments: gy } = geometry.parameters;
  const data = new Float32Array((gx + 1) * (gy + 1) * 2);
  for (let iy = 0; iy <= gy; iy++) {
    for (let ix = 0; ix <= gx; ix++) {
      const i = (iy * (gx + 1) + ix) * 2;
      data[i] = ix / gx;
      data[i + 1] = 1 - iy / gy;
    }
  }
  geometry.setAttribute('facadeUv', new BufferAttribute(data, 2));
  // The relief's bump map reads the same coordinates through three's second UV channel.
  geometry.setAttribute('uv1', new BufferAttribute(data, 2));
}

/**
 * The relief as a bump map, so window reveals and slab edges shade crisply even between the
 * displaced vertices. Rows are flipped to match the v-up facade coordinates.
 */
function bumpTexture(pixels: ReliefPixels): DataTexture {
  const { width, height, data } = pixels;
  const flipped = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) flipped.set(data.subarray((height - 1 - y) * width, (height - y) * width), y * width);
  const t = new DataTexture(flipped, width, height, RedFormat);
  t.channel = 1;
  t.magFilter = LinearFilter;
  t.minFilter = LinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Bump height per relief unit: a little under the displacement, which already shades the large forms. */
const BUMP_PER_METRE = 1.2;

/** Moves each vertex along the wall's normal (local +z) by the relief there. */
export function displaceWall(geometry: PlaneGeometry, relief: WallRelief): void {
  const { widthSegments: gx, heightSegments: gy } = geometry.parameters;
  const position = geometry.getAttribute('position') as BufferAttribute;
  for (let iy = 0; iy <= gy; iy++) {
    for (let ix = 0; ix <= gx; ix++) {
      position.setZ(iy * (gx + 1) + ix, reliefAt(relief.pixels, ix / gx, iy / gy) * relief.depthM);
    }
  }
  position.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}

function wallMaterial(map: Texture | null, relief: WallRelief | null): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    map,
    color: map ? 0xffffff : PLAIN_WALL_COLOR,
    roughness: 1,
    metalness: 0,
  });
  if (relief && relief.depthM > 0) {
    material.bumpMap = bumpTexture(relief.pixels);
    material.bumpScale = relief.depthM * BUMP_PER_METRE;
  }
  const overlay = { value: transparentTexture() as Texture };
  material.userData.overlay = overlay;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.overlayMap = overlay;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 facadeUv;\nvarying vec2 vFacadeUv;')
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = facadeUv;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D overlayMap;\nvarying vec2 vFacadeUv;')
      .replace(
        '#include <map_fragment>',
        '#include <map_fragment>\nvec4 overlayTexel = texture2D(overlayMap, vFacadeUv);\ndiffuseColor.rgb = mix(diffuseColor.rgb, overlayTexel.rgb, overlayTexel.a);',
      );
  };
  material.customProgramCacheKey = () => (material.bumpMap ? 'abb360-wall-bump' : 'abb360-wall');
  return material;
}

/** Sets the texture holding this wall's apartment colours. */
export function setWallOverlay(wall: WallMesh, texture: Texture): void {
  (wall.material.userData.overlay as { value: Texture }).value = texture;
}

export function createWall(
  f: FacadeId,
  d: Dimensions,
  corners: Corners,
  map: Texture | null,
  relief: WallRelief | null = null,
): WallMesh {
  const frame = facadeFrame(f, d);
  const gx = relief ? RELIEF_SEGMENTS_U : WALL_SEGMENTS;
  const gy = relief ? Math.min(384, Math.max(64, Math.round((RELIEF_SEGMENTS_U * frame.height) / frame.width))) : WALL_SEGMENTS;
  const geometry = new PlaneGeometry(frame.width, frame.height, gx, gy);
  if (map) writeWallUvs(geometry, corners);
  writeFacadeUvs(geometry);
  if (relief && relief.depthM > 0) displaceWall(geometry, relief);
  const wall = new Mesh(geometry, wallMaterial(map, relief));
  wall.name = `wall-${f}`;
  wall.userData.facade = f;
  wall.castShadow = true;
  wall.receiveShadow = true;
  wall.rotation.y = frame.rotationY;
  wall.position.set(...frame.center);

  // Picking hits this flat, invisible stand-in rather than the dense displaced surface.
  const proxy = new Mesh(new PlaneGeometry(frame.width, frame.height), new MeshBasicMaterial({ visible: false, side: FrontSide }));
  proxy.name = `pick-${f}`;
  proxy.userData.facade = f;
  wall.add(proxy);
  return wall;
}

/** The invisible picking plane of a wall. */
export function pickProxy(wall: WallMesh): Mesh {
  return wall.children.find((c) => c.name.startsWith('pick-')) as Mesh;
}
