// Every city's roads and footpaths drawn with one pair of surfaces instead of each map's own (many were
// blurry, blotchy or the wrong scale): photo-scanned European asphalt and concrete slabs from the "Roads of
// Europe: Definitive Edition" street retexture for GTA V (Mouhzanfarydeh, gta5-mods.com; public/mods/roads/,
// see assets/CREDITS.md). Which of a map's textures are road and which footpath comes from
// public/mods/roads/surfaces.json (scripts/road-surfaces.mjs: what lies under the road network, and what
// stands kerb-high beside it).
//
// The new surfaces are laid from above in world space (TILE m per repeat), not by the maps' texture
// coordinates, so the grain is the same size in every city. Per pixel, from the map's own texture (still
// read at its own coordinates):
//   paint     where it's much brighter than the texture's own surface, or strongly yellow or orange (lane
//             lines, hatching, arrows painted into the road texture), the paint shows through
//   footpath  where a texture made for roads is used for footpaths too, the parts standing kerb-high above
//             the road (map.ts `kerb` per vertex) are drawn as footpath
import * as THREE from 'three';

export type Surface = 'road' | 'walk';

export interface SurfaceInfo {
  kind: Surface;
}

const TILE: Record<Surface, number> = { road: 3, walk: 3.5 }; // m per repeat (the scans' own scale: finer grain)
const NORMAL = 0.6; // the scans' relief, softened: at full strength the grit reads coarser than it is
/**
 * Each city's asphalt, and a second one laid in patches across it (resurfaced stretches, older wear), so
 * the roads differ from place to place and a long road isn't one texture: the Roads of Europe scans (a
 * city street's, a worn one, a freeway's, fresh tarmac).
 */
const ASPHALT: Record<string, [string, string]> = {
  chicago: ['town', 'worn'],
  lordcity: ['roadb', 'worn'],
  'french-riviera': ['new', 'road'],
  shibuya: ['town', 'new'],
  'ugase-city': ['town', 'roadb'],
  akina: ['freeway', 'worn'],
  tsukuba: ['freeway', 'roadb'],
  'carla-town10': ['road', 'new'],
  'carla-town12': ['road', 'roadb'],
};
const DEFAULT_ASPHALT: [string, string] = ['road', 'roadb'];
const ROUGHNESS = 0.86;
const DIR = '/mods/roads/roads-of-europe';

let lists: Promise<Record<string, { road: string[]; walk: string[] }>> | null = null;

/** Whether a map's texture is one of its roads or footpaths. */
export async function surfaceOf(city: string, texture: string | null | undefined): Promise<SurfaceInfo | null> {
  if (!texture) return null;
  lists ??= fetch('/mods/roads/surfaces.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
  const l = (await lists)[city];
  if (!l) return null;
  if (l.road?.includes(texture)) return { kind: 'road' };
  return l.walk?.includes(texture) ? { kind: 'walk' } : null;
}

const loaded = new Map<string, Promise<THREE.Texture | null>>();

/** One of the road scans (public/mods/roads/roads-of-europe/<name>.jpg), loaded once. */
function scan(name: string, color: boolean): Promise<THREE.Texture | null> {
  let t = loaded.get(name);
  if (!t) {
    t = new THREE.TextureLoader().loadAsync(`${DIR}/${name}.jpg`).then((tex) => {
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.anisotropy = 16;
      if (color) tex.colorSpace = THREE.SRGBColorSpace;
      return tex;
    }).catch(() => null);
    loaded.set(name, t);
  }
  return t;
}

/** The material for one of a map's road or footpath textures (`original`: that texture, for its paint). */
export async function surfaceMaterial(info: SurfaceInfo, original: THREE.Texture | null, city: string): Promise<THREE.MeshStandardMaterial> {
  const [main, patch] = ASPHALT[city] ?? DEFAULT_ASPHALT;
  const [road, roadN, patchMap, patchN, walkMap, walkN] = await Promise.all([
    scan(main, true), scan(`${main}_n`, false), scan(patch, true), scan(`${patch}_n`, false), scan('walk', true), scan('walk_n', false),
  ]);
  const t = { walk: walkMap, walkN, roadN };
  const mat = new THREE.MeshStandardMaterial({
    map: road, normalMap: roadN, color: 0xffffff, roughness: ROUGHNESS, metalness: 0,
  });
  mat.normalScale.set(NORMAL, NORMAL);
  mat.name = `surface:${info.kind}`;
  const paint = info.kind === 'road' && original ? original : null;
  const defines: string[] = [];
  if (paint) defines.push('#define USE_PAINT');
  const roadTile = TILE.road.toFixed(2);
  const walk = TILE.walk.toFixed(2);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.patchMap = { value: patchMap ?? road };
    shader.uniforms.patchNormal = { value: patchN ?? roadN };
    shader.uniforms.walkMap = { value: t.walk };
    shader.uniforms.walkNormal = { value: t.walkN ?? t.roadN };
    shader.uniforms.paintMap = { value: paint };
    shader.uniforms.uWalk = { value: info.kind === 'walk' ? 1 : 0 };
    const head = `${defines.join('\n')}
      varying vec2 vWorldXZ;
      varying vec2 vPaintUv;
      varying float vKerb;`;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${head}\nattribute float kerb;`)
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vKerb = kerb;
        vWorldXZ = (modelMatrix * vec4(position, 1.0)).xz;
        vPaintUv = uv;
        vMapUv = vWorldXZ / ${roadTile};
        vNormalMapUv = vMapUv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${head}
        uniform sampler2D patchMap;
        uniform sampler2D patchNormal;
        uniform sampler2D walkMap;
        uniform sampler2D walkNormal;
        // Value noise over the world: where the second asphalt lies, in patches tens of metres across
        float surfaceHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
        float surfaceNoise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(surfaceHash(i), surfaceHash(i + vec2(1.0, 0.0)), u.x), mix(surfaceHash(i + vec2(0.0, 1.0)), surfaceHash(i + vec2(1.0, 1.0)), u.x), u.y);
        }
        uniform sampler2D paintMap;
        uniform float uWalk;`)
      .replace('#include <map_fragment>', `
        float walkF = max(uWalk, step(0.5, vKerb));
        float patchF = smoothstep(0.56, 0.7, surfaceNoise(vWorldXZ / 45.0) * 0.7 + surfaceNoise(vWorldXZ / 11.0) * 0.3);
        vec4 asphalt = mix(texture2D(map, vWorldXZ / ${roadTile}), texture2D(patchMap, vWorldXZ / ${roadTile}), patchF);
        vec4 surface = mix(asphalt, texture2D(walkMap, vWorldXZ / ${walk}), walkF);
        #ifdef USE_PAINT
          // Paint in the map's own texture: bright (white lines) or strongly coloured (yellow, orange)
          // …brighter than the texture's own surface by a clear margin (its average, from a small mip), so a
          // light grey road isn't taken for paint
          vec4 painted = texture2D(paintMap, vPaintUv);
          vec3 around = textureLod(paintMap, vPaintUv, 7.0).rgb;
          float lum = dot(painted.rgb, vec3(0.2126, 0.7152, 0.0722));
          float base = dot(around, vec3(0.2126, 0.7152, 0.0722));
          float sat = max(painted.r, max(painted.g, painted.b)) - min(painted.r, min(painted.g, painted.b));
          float paintF = (1.0 - walkF) * max(smoothstep(0.16, 0.3, lum - base) * step(0.22, lum), smoothstep(0.28, 0.5, sat) * smoothstep(0.1, 0.18, lum));
          surface.rgb = mix(surface.rgb, painted.rgb, paintF);
        #endif
        diffuseColor *= surface;`)
      .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 roadNormal = mix(texture2D(normalMap, vWorldXZ / ${roadTile}).xyz, texture2D(patchNormal, vWorldXZ / ${roadTile}).xyz, patchF);
          vec3 mapN = mix(roadNormal, texture2D(walkNormal, vWorldXZ / ${walk}).xyz, walkF) * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        #else
          #include <normal_fragment_maps>
        #endif`);
  };
  // Each map texture its own program variant (paint, split), and map.ts patches the lighting in later
  mat.customProgramCacheKey = () => `surface-v3-${defines.join()}-${mat.userData.lit ? 'lit' : 'plain'}`;
  return mat;
}
