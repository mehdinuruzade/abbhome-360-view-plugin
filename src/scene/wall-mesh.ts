import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  FrontSide,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RedFormat,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { reliefAt, smoothstep, type ReliefPixels } from '../core/depth';
import { imageToTextureUv } from '../core/facade-frame';
import { applyH, squareToQuad } from '../core/homography';
import { elevationUv, occluderHeight, wallPoint, type Block, type Wall } from '../core/massing';
import type { Corners, Dimensions, FacadeId } from '../core/types';

/**
 * One wall of the building: a subdivided rectangle along a footprint edge. Each vertex shows the
 * elevation photo the wall faces, projected straight onto it (facade (u, v), then the corner
 * homography to the photo), so a recessed or set-back wall shows exactly the part of the photo
 * that is in front of it. Where another part of the building hides the wall in that photo (a
 * courtyard side wall, a tower's base behind its podium), the wall takes a plain tone instead.
 *
 * With a relief map the wall is denser and pushed in and out along its normal (fading to the
 * plane near its edges so corners stay closed), and the relief also shades it as a bump map.
 * The apartment colours are painted on the wall itself: a per-facade overlay texture mixed into
 * the albedo by a small shader hook.
 */

export const PLAIN_WALL_COLOR = 0xd8d3cb;
/** Vertices per metre along a wall with relief (224 across a 30 m wall). */
const RELIEF_PER_METRE = 7.5;
const MAX_RELIEF_SEGMENTS = 320;
/** Metres per segment on a flat wall: enough for the keystone homography and occlusion edges. */
const FLAT_SEGMENT_M = 2;
const MAX_FLAT_SEGMENTS = 32;
/** Relief fades to the wall plane over this many metres at every edge of a wall. */
const RELIEF_EDGE_FADE_M = 0.5;
/** Bump height per relief unit: a little under the displacement, which already shades the large forms. */
const BUMP_PER_METRE = 1.2;

export interface WallRelief {
  pixels: ReliefPixels;
  depthM: number;
}

/** What a wall shows: its facade's photo, corners and relief, and a tone for hidden parts. */
export interface WallLook {
  map: Texture | null;
  corners: Corners;
  relief: WallRelief | null;
  /** Average colour of the wall in its photo (linear), for parts the photo can't show. */
  tone: Color | null;
}

export type WallMesh = Mesh<BufferGeometry, MeshStandardMaterial>;

/** A transparent 1×1 texture, so the overlay sampler always has something valid bound. */
function transparentTexture(): DataTexture {
  const t = new DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
  t.colorSpace = SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/**
 * Photo UVs from each vertex's facade (u, v) through the corner homography. False (and UVs
 * untouched) when the corners don't form a valid quad.
 */
export function writeWallUvs(geometry: BufferGeometry, corners: Corners): boolean {
  const h = squareToQuad(corners);
  if (!h) return false;
  const facadeUv = geometry.getAttribute('facadeUv') as BufferAttribute;
  const uv = geometry.getAttribute('uv') as BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    const [tu, tv] = imageToTextureUv(applyH(h, facadeUv.getX(i), 1 - facadeUv.getY(i)));
    uv.setXY(i, tu, tv);
  }
  uv.needsUpdate = true;
  return true;
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

function wallMaterial(look: WallLook): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    map: look.map,
    color: look.map ? 0xffffff : PLAIN_WALL_COLOR,
    roughness: 1,
    metalness: 0,
  });
  const { relief } = look;
  if (relief && relief.depthM > 0) {
    material.bumpMap = bumpTexture(relief.pixels);
    material.bumpScale = relief.depthM * BUMP_PER_METRE;
  }
  const overlay = { value: transparentTexture() as Texture };
  // Without a photo the material colour already is the plain tone; the photo is multiplied in.
  const tone = { value: look.map ? (look.tone ?? new Color(PLAIN_WALL_COLOR)) : new Color(1, 1, 1) };
  material.userData.overlay = overlay;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.overlayMap = overlay;
    shader.uniforms.hiddenTone = tone;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute vec2 facadeUv;\nattribute float photoMix;\nvarying vec2 vFacadeUv;\nvarying float vPhotoMix;',
      )
      .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFacadeUv = facadeUv;\nvPhotoMix = photoMix;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nuniform sampler2D overlayMap;\nuniform vec3 hiddenTone;\nvarying vec2 vFacadeUv;\nvarying float vPhotoMix;',
      )
      .replace(
        '#include <map_fragment>',
        [
          '#include <map_fragment>',
          // Parts of the wall the photo can't show take the wall's average tone, without apartments.
          'diffuseColor.rgb = mix(diffuse * hiddenTone, diffuseColor.rgb, vPhotoMix);',
          'vec4 overlayTexel = texture2D(overlayMap, vFacadeUv);',
          'diffuseColor.rgb = mix(diffuseColor.rgb, overlayTexel.rgb, overlayTexel.a * vPhotoMix);',
        ].join('\n'),
      );
  };
  material.customProgramCacheKey = () => (material.bumpMap ? 'abb360-wall-bump' : 'abb360-wall');
  return material;
}

/** Sets the texture holding this wall's apartment colours. */
export function setWallOverlay(wall: WallMesh, texture: Texture): void {
  (wall.material.userData.overlay as { value: Texture }).value = texture;
}

/** One wall's grid in world coordinates, laid out like PlaneGeometry (rows from the top, columns from the left). */
export function wallGeometry(
  wall: Wall,
  d: Dimensions,
  blocks: readonly Block[],
  corners: Corners | null,
  relief: WallRelief | null,
  detail = 1,
): BufferGeometry {
  const displaced = !!relief && relief.depthM > 0;
  const segments = (metres: number) =>
    displaced
      ? Math.min(MAX_RELIEF_SEGMENTS, Math.max(2, Math.ceil(metres * RELIEF_PER_METRE * detail)))
      : Math.min(MAX_FLAT_SEGMENTS, Math.max(2, Math.ceil(metres / FLAT_SEGMENT_M)));
  const gx = segments(wall.length);
  const gy = segments(wall.height);
  const count = (gx + 1) * (gy + 1);
  const position = new Float32Array(count * 3);
  const facadeUv = new Float32Array(count * 2);
  const photoMix = new Float32Array(count);
  const [nx, nz] = wall.normal;

  for (let ix = 0; ix <= gx; ix++) {
    const t = ix / gx;
    const [x, z] = wallPoint(wall, t);
    const hiddenBelow = occluderHeight(wall.facade, [x, z], blocks);
    const along = Math.min(t, 1 - t) * wall.length;
    for (let iy = 0; iy <= gy; iy++) {
      const y = wall.height * (1 - iy / gy);
      const i = iy * (gx + 1) + ix;
      const [u, v] = elevationUv(wall.facade, [x, y, z], d);
      const visible = y > hiddenBelow + 1e-3 ? 1 : 0;
      let offset = 0;
      if (displaced && relief && visible) {
        const edge = Math.min(along, y, wall.height - y);
        offset = reliefAt(relief.pixels, u, v) * relief.depthM * smoothstep(0, RELIEF_EDGE_FADE_M, edge);
      }
      position[i * 3] = x + nx * offset;
      position[i * 3 + 1] = y;
      position[i * 3 + 2] = z + nz * offset;
      // Stored v-up, to match how three samples canvas textures.
      facadeUv[i * 2] = u;
      facadeUv[i * 2 + 1] = 1 - v;
      photoMix[i] = visible;
    }
  }

  const index: number[] = [];
  for (let iy = 0; iy < gy; iy++) {
    for (let ix = 0; ix < gx; ix++) {
      const a = iy * (gx + 1) + ix;
      const b = (iy + 1) * (gx + 1) + ix;
      index.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setIndex(index);
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('uv', new BufferAttribute(new Float32Array(count * 2), 2));
  geometry.setAttribute('facadeUv', new BufferAttribute(facadeUv, 2));
  // The relief's bump map reads the same coordinates through three's second UV channel.
  geometry.setAttribute('uv1', new BufferAttribute(facadeUv, 2));
  geometry.setAttribute('photoMix', new BufferAttribute(photoMix, 1));
  geometry.userData.segments = [gx, gy];
  if (corners) writeWallUvs(geometry, corners);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** The flat, undisplaced wall: what picking hits. */
function proxyGeometry(wall: Wall): BufferGeometry {
  const [ax, az] = wall.a;
  const [bx, bz] = wall.b;
  const h = wall.height;
  const g = new BufferGeometry();
  // Top-left, bottom-left, top-right, bottom-right as seen from outside.
  g.setAttribute('position', new BufferAttribute(new Float32Array([ax, h, az, ax, 0, az, bx, h, bz, bx, 0, bz]), 3));
  g.setIndex([0, 1, 2, 1, 3, 2]);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

export function createWall(wall: Wall, index: number, d: Dimensions, blocks: readonly Block[], look: WallLook, detail = 1): WallMesh {
  const geometry = wallGeometry(wall, d, blocks, look.map ? look.corners : null, look.relief, detail);
  const mesh = new Mesh(geometry, wallMaterial(look));
  mesh.name = `wall-${index}-${wall.facade}`;
  mesh.userData.facade = wall.facade;
  mesh.userData.wall = index;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Picking hits this flat, invisible stand-in rather than the dense displaced surface.
  const proxy = new Mesh(proxyGeometry(wall), new MeshBasicMaterial({ visible: false, side: FrontSide }));
  proxy.name = `pick-${index}-${wall.facade}`;
  proxy.userData.facade = wall.facade;
  proxy.userData.wall = index;
  mesh.add(proxy);
  return mesh;
}

/** The invisible picking surface of a wall. */
export function pickProxy(wall: WallMesh): Mesh {
  return wall.children.find((c) => c.name.startsWith('pick-')) as Mesh;
}

/** The walls showing a given facade's photo. */
export function wallsShowing(walls: readonly WallMesh[], f: FacadeId): WallMesh[] {
  return walls.filter((w) => w.userData.facade === f);
}
