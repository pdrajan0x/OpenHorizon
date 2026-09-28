// Replacement surfaces for a city's low-resolution textures: public/mods/maps/<id>/retexture.json maps a
// texture name to a Poly Haven scan (CC0, public/mods/retex/<scan>/Diffuse|nor_gl|Rough.jpg) and how it is
// laid: from above in world metres (ground, grass), or triplanar (cliffs, where a top-down projection
// would smear down the faces). The map's own texture coordinates aren't used, so the grain is true to size.
import * as THREE from 'three';

interface Entry {
  scan: string;
  tile: number; // m per repeat
  triplanar?: boolean;
  tint?: number;
}

const lists = new Map<string, Promise<Record<string, Entry>>>();
const scans = new Map<string, Promise<(THREE.Texture | null)[]>>();

/** The replacement for one of a city's textures, or null. */
export async function retextureOf(city: string, texture: string | null | undefined): Promise<Entry | null> {
  if (!texture) return null;
  let l = lists.get(city);
  if (!l) lists.set(city, (l = fetch(`/mods/maps/${city}/retexture.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))));
  return (await l)[texture] ?? null;
}

function load(scan: string): Promise<(THREE.Texture | null)[]> {
  let p = scans.get(scan);
  if (!p) {
    const loader = new THREE.TextureLoader();
    const one = (name: string, color: boolean) => loader.loadAsync(`/mods/retex/${scan}/${name}.jpg`).then((t) => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.anisotropy = 16;
      if (color) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    }).catch(() => null);
    scans.set(scan, (p = Promise.all([one('Diffuse', true), one('nor_gl', false), one('Rough', false)])));
  }
  return p;
}

export async function retextureMaterial(e: Entry): Promise<THREE.MeshStandardMaterial> {
  const [map, normalMap, roughnessMap] = await load(e.scan);
  const mat = new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, roughness: 1, metalness: 0, color: e.tint ?? 0xffffff });
  mat.name = `retex:${e.scan}`;
  const tile = e.tile.toFixed(2);
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRetexPos;\nvarying vec3 vRetexNormal;')
      .replace('#include <uv_vertex>', `#include <uv_vertex>
        vRetexPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vRetexNormal = normalize(mat3(modelMatrix) * normal);`);
    // Sample a map from above, or blended from the three axes by the surface's facing
    const sample = e.triplanar
      ? `vec3 bw = pow(abs(vRetexNormal), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
         #define RETEX(tex) (texture2D(tex, vRetexPos.zy / ${tile}) * bw.x + texture2D(tex, vRetexPos.xz / ${tile}) * bw.y + texture2D(tex, vRetexPos.xy / ${tile}) * bw.z)`
      : `#define RETEX(tex) texture2D(tex, vRetexPos.xz / ${tile})`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRetexPos;\nvarying vec3 vRetexNormal;`)
      .replace('#include <map_fragment>', `${sample}\n#ifdef USE_MAP\n diffuseColor *= RETEX(map);\n#endif`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;\n#ifdef USE_ROUGHNESSMAP\n roughnessFactor *= RETEX(roughnessMap).g;\n#endif`)
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = RETEX(normalMap).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        #endif`);
  };
  mat.customProgramCacheKey = () => `retex-${e.triplanar ? 't' : 'p'}-${tile}-${mat.userData.lit ? 'lit' : 'plain'}`;
  return mat;
}
