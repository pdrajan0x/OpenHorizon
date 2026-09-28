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
  /** A second scan for slopes (rock on a hillside), blended in by steepness; drawn triplanar. */
  steep?: { scan: string; tile: number };
}

const lists = new Map<string, Promise<Record<string, Entry>>>();
const scans = new Map<string, Promise<(THREE.Texture | null)[]>>();

/**
 * The replacement for one of a city's textures, or null. A material with no texture at all (GTA's layered
 * terrain shaders, which the converter doesn't read) is matched by its shader: "shader:<name>"; any one
 * material by its number in the map's manifest: "#<index>".
 */
export async function retextureOf(city: string, texture: string | null | undefined, shader?: string, index?: number): Promise<Entry | null> {
  let l = lists.get(city);
  if (!l) lists.set(city, (l = fetch(`/mods/maps/${city}/retexture.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))));
  const list = await l;
  // One material by its number in the manifest ("#1289"), else by texture, else (untextured) by shader
  return (index !== undefined ? list[`#${index}`] : undefined) ?? (texture ? list[texture] : shader ? list[`shader:${shader}`] : null) ?? null;
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
  const [steepMap, steepNormal] = e.steep ? await load(e.steep.scan) : [null, null];
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
    if (e.steep) {
      shader.uniforms.steepMap = { value: steepMap };
      shader.uniforms.steepNormal = { value: steepNormal ?? normalMap };
    }
    const sample = e.triplanar
      ? `vec3 bw = pow(abs(vRetexNormal), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
         #define RETEX(tex) (texture2D(tex, vRetexPos.zy / ${tile}) * bw.x + texture2D(tex, vRetexPos.xz / ${tile}) * bw.y + texture2D(tex, vRetexPos.xy / ${tile}) * bw.z)`
      : `#define RETEX(tex) texture2D(tex, vRetexPos.xz / ${tile})`;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vRetexPos;\nvarying vec3 vRetexNormal;${e.steep ? '\nuniform sampler2D steepMap;\nuniform sampler2D steepNormal;' : ''}`)
      .replace('#include <map_fragment>', `${sample}
        ${e.steep ? `vec3 sw = pow(abs(vRetexNormal), vec3(4.0)); sw /= (sw.x + sw.y + sw.z);
        #define STEEP(tex) (texture2D(tex, vRetexPos.zy / ${e.steep.tile.toFixed(2)}) * sw.x + texture2D(tex, vRetexPos.xz / ${e.steep.tile.toFixed(2)}) * sw.y + texture2D(tex, vRetexPos.xy / ${e.steep.tile.toFixed(2)}) * sw.z)
        float steepF = 1.0 - smoothstep(0.62, 0.8, abs(vRetexNormal.y));` : 'float steepF = 0.0;'}
        #ifdef USE_MAP
          diffuseColor *= ${e.steep ? 'mix(RETEX(map), STEEP(steepMap), steepF)' : 'RETEX(map)'};
        #endif`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = roughness;\n#ifdef USE_ROUGHNESSMAP\n roughnessFactor *= RETEX(roughnessMap).g;\n#endif`)
      .replace('#include <normal_fragment_maps>', `#ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = ${e.steep ? 'mix(RETEX(normalMap).xyz, STEEP(steepNormal).xyz, steepF)' : 'RETEX(normalMap).xyz'} * 2.0 - 1.0;
          mapN.xy *= normalScale;
          normal = normalize(tbn * mapN);
        #endif`);
  };
  mat.customProgramCacheKey = () => `retex-${e.triplanar ? 't' : 'p'}-${tile}-${e.steep ? e.steep.tile : 0}-${mat.userData.lit ? 'lit' : 'plain'}`;
  return mat;
}
