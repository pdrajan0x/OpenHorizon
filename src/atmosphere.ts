// Sky and light from a photographed sky (an HDRI from Poly Haven, public/mods/sky/<time>.hdr, fetched by
// scripts/fetch-environment.mjs): it's the backdrop, the image-based light every surface picks up, and
// where the sun is. Haze takes its colour from the sky at the horizon. Rain is optional (?rain).
import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { setMapLighting } from './map';
import type { Bloom } from './postfx';
import { EFFECTS } from './quality';

export type TimeOfDay = 'day' | 'sunset' | 'night';

interface Look {
  exposure: number;
  sun: number; // directional light intensity (the sky photograph lights everything else)
  environment: number; // how strongly the photograph lights surfaces
  fog: number; // FogExp2 density
  night: number; // 0..1: how much lit windows and signs glow
  bloom: Bloom;
}
const LOOKS: Record<TimeOfDay, Look> = {
  // A strong sun against a dimmer sky: the contrast between sunlit and shaded faces is what gives the
  // city depth (an even sky light flattens it)
  day: { exposure: 0.9, sun: 3.2, environment: 0.45, fog: 0.0004, night: 0, bloom: { strength: 0.25, radius: 0.3, threshold: 4 } },
  sunset: { exposure: 0.7, sun: 3.0, environment: 0.42, fog: 0.0004, night: 0.35, bloom: { strength: 0.45, radius: 0.35, threshold: 3 } },
  night: { exposure: 1.8, sun: 0.2, environment: 1.4, fog: 0.0006, night: 1, bloom: { strength: 1.2, radius: 0.5, threshold: 0.7 } },
};
/** The look for a time of day; ?look=sun:3,environment:0.5,exposure:0.8 overrides numbers (for tuning). */
function tunedLook(time: TimeOfDay): Look {
  const look = { ...LOOKS[time] };
  for (const pair of (new URLSearchParams(location.search).get('look') ?? '').split(',')) {
    const [k, v] = pair.split(':');
    if (k in look && k !== 'bloom' && Number.isFinite(Number(v))) (look as unknown as Record<string, number>)[k] = Number(v);
  }
  return look;
}
const HORIZON_BLEND = 0.05; // fraction of the photograph's height above the horizon faded into haze
// Sun shadows: two cascades out to SHADOW_DISTANCE, soft PCF. None at night (the "sun" is moonlight).
const SHADOW_DISTANCE = 250;
const SHADOW_MAP_SIZE = 2048;
const RESCAN_FRAMES = 30; // how often new lit materials (cars spawning) are hooked up to the cascades
const RAIN_DROPS = 6000;
const RAIN_BOX = 120; // meters around the camera
const RAIN_HEIGHT = 60;

export class Atmosphere {
  readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  readonly look: Look;
  private readonly sunOffset = new THREE.Vector3();
  private readonly rain: THREE.ShaderMaterial | null;
  private csm: CSM | null = null;
  private shadowCamera: THREE.PerspectiveCamera | null = null;
  private readonly lastProjection = new THREE.Matrix4();
  private frames = 0;

  private constructor(private readonly scene: THREE.Scene, sky: THREE.DataTexture, environment: THREE.Texture, readonly time: TimeOfDay, rain: boolean) {
    this.look = tunedLook(time);
    scene.background = sky;
    scene.environment = environment;
    scene.environmentIntensity = this.look.environment;

    // The sun sits where the photograph is brightest; the haze is the colour of its horizon
    const { sun, horizon } = analyse(sky);
    this.sunOffset.copy(sun).multiplyScalar(1000);
    this.sun.position.copy(this.sunOffset);
    this.sun.intensity = this.look.sun;
    this.sun.color.copy(sunColour(sky, sun));
    scene.add(this.sun, this.sun.target);
    scene.fog = new THREE.FogExp2(horizon, this.look.fog);
    this.rain = rain ? addRain(scene) : null;
  }

  static async load(renderer: THREE.WebGLRenderer, scene: THREE.Scene, time: TimeOfDay, rain = false): Promise<Atmosphere> {
    // ?sky=<name> tries another photograph from public/mods/sky/ (for choosing skies)
    const sky = await new HDRLoader().loadAsync(`/mods/sky/${new URLSearchParams(location.search).get('sky') ?? time}.hdr`);
    sky.mapping = THREE.EquirectangularReflectionMapping;
    seaBelowHorizon(sky);
    const pmrem = new THREE.PMREMGenerator(renderer);
    const environment = pmrem.fromEquirectangular(sky).texture;
    pmrem.dispose();
    renderer.toneMappingExposure = tunedLook(time).exposure;
    // Khronos PBR Neutral by day keeps surfaces the colour of their textures (ACES darkens and
    // desaturates brick, paint and glass); night keeps ACES's richer neon. ?tm=aces|agx|neutral to compare.
    const tm = new URLSearchParams(location.search).get('tm');
    renderer.toneMapping = tm === 'agx' ? THREE.AgXToneMapping : tm === 'aces' ? THREE.ACESFilmicToneMapping
      : tm === 'neutral' || time !== 'night' ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
    return new Atmosphere(scene, sky, environment, time, rain);
  }

  /**
   * Cascaded sun shadows for this camera (off at ?quality=low and at night). The cascades' lights
   * replace the plain sun, and every lit material in the scene is set up for them.
   */
  castShadows(renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): void {
    if (!EFFECTS.shadows || this.time === 'night' || this.csm) return;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    const csm = new CSM({
      camera,
      parent: this.scene,
      cascades: 2,
      maxFar: SHADOW_DISTANCE,
      mode: 'practical',
      shadowMapSize: SHADOW_MAP_SIZE,
      lightDirection: this.sunOffset.clone().normalize().negate(),
      lightIntensity: this.look.sun,
      lightNear: 1,
      lightFar: 3000,
      lightMargin: 400, // towers outside the view still shade the street
      shadowBias: -0.0002,
    });
    csm.fade = true;
    for (const light of csm.lights) {
      light.color.copy(this.sun.color);
      light.shadow.normalBias = 0.04;
      light.shadow.radius = 2;
    }
    this.scene.remove(this.sun);
    this.csm = csm;
    this.shadowCamera = camera;
    this.lastProjection.copy(camera.projectionMatrix);
    csm.updateFrustums();
    setMapLighting((m) => csm.setupMaterial(m));
    this.hookMaterials();
  }

  /** Lit materials not set up for the cascades would take every cascade's light: set them up. */
  private hookMaterials(): void {
    const csm = this.csm!;
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const lit = m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshLambertMaterial || m instanceof THREE.MeshPhongMaterial;
        if (!lit || m.userData.lit) continue;
        m.userData.lit = true;
        const own = m.onBeforeCompile;
        csm.setupMaterial(m);
        const cascades = m.onBeforeCompile;
        m.onBeforeCompile = (shader, renderer) => {
          cascades.call(m, shader, renderer);
          own.call(m, shader, renderer);
        };
        m.needsUpdate = true;
      }
    });
  }

  update(time: number, camera: THREE.Vector3): void {
    // The sun's light follows the camera so its direction is the same everywhere on the islands
    this.sun.target.position.copy(camera);
    this.sun.position.copy(this.sun.target.position).add(this.sunOffset);
    if (this.csm) {
      // The chase camera's FOV breathes with speed: refit the cascades when the projection changes
      if (!this.lastProjection.equals(this.shadowCamera!.projectionMatrix)) {
        this.lastProjection.copy(this.shadowCamera!.projectionMatrix);
        this.csm.updateFrustums();
      }
      this.shadowCamera!.updateMatrixWorld();
      this.csm.update();
      if (++this.frames % RESCAN_FRAMES === 0) this.hookMaterials();
    }
    if (this.rain) {
      this.rain.uniforms.uTime.value = time;
      this.rain.uniforms.uCam.value.copy(camera);
    }
  }

}

/**
 * The photographs are skies only; below the horizon is the sea. Beyond the camera's far plane (3 km)
 * the ocean isn't drawn, so paint the lower half with the haze at the horizon: the sea fades into it.
 */
function seaBelowHorizon(sky: THREE.DataTexture): void {
  const { data, width, height } = sky.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const { horizon } = analyse(sky);
  const half = data instanceof Uint16Array;
  const get = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  const put = (i: number, v: number) => (data[i] = half ? THREE.DataUtils.toHalfFloat(v) : v);
  // A band of sky above the horizon eases into the haze, so there's no seam
  const blendFrom = Math.floor(height * (0.5 - HORIZON_BLEND));
  for (let y = blendFrom; y < height; y++) {
    const t = Math.min(1, (y - blendFrom) / (height / 2 - blendFrom));
    const k = t * t * (3 - 2 * t);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      put(i, get(i) + (horizon.r - get(i)) * k);
      put(i + 1, get(i + 1) + (horizon.g - get(i + 1)) * k);
      put(i + 2, get(i + 2) + (horizon.b - get(i + 2)) * k);
    }
  }
  sky.needsUpdate = true;
}

/** Direction of the brightest pixel above the horizon, and the average colour just above the horizon. */
function analyse(sky: THREE.DataTexture): { sun: THREE.Vector3; horizon: THREE.Color } {
  const { data, width, height } = sky.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const half = data instanceof Uint16Array;
  const at = (i: number) => (half ? THREE.DataUtils.fromHalfFloat(data[i]) : data[i]);
  let best = -1;
  let bx = 0;
  let by = 0;
  // Row 0 is the top of the photograph (zenith); the horizon is the middle row
  for (let y = 0; y < height / 2; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const i = (y * width + x) * 4;
      const l = at(i) * 0.2126 + at(i + 1) * 0.7152 + at(i + 2) * 0.0722;
      if (l > best) {
        best = l;
        bx = x;
        by = y;
      }
    }
  }
  const sun = direction((bx + 0.5) / width, 1 - (by + 0.5) / height);
  // Haze colour: the sky just above the horizon, leaving out the brightest tenth (the sun's glare)
  const row = Math.floor(height * 0.47);
  const samples: [number, number, number, number][] = [];
  for (let x = 0; x < width; x += 4) {
    const i = (row * width + x) * 4;
    const r = at(i);
    const g = at(i + 1);
    const b = at(i + 2);
    samples.push([r * 0.2126 + g * 0.7152 + b * 0.0722, r, g, b]);
  }
  samples.sort((p, q) => p[0] - q[0]);
  const kept = samples.slice(0, Math.floor(samples.length * 0.9));
  const horizon = new THREE.Color(0, 0, 0);
  for (const [, r, g, b] of kept) {
    horizon.r += r / kept.length;
    horizon.g += g / kept.length;
    horizon.b += b / kept.length;
  }
  return { sun, horizon };
}

/** The sun's colour: the photograph around it, normalised to its brightest channel. */
function sunColour(sky: THREE.DataTexture, sun: THREE.Vector3): THREE.Color {
  const { data, width, height } = sky.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const half = data instanceof Uint16Array;
  const u = Math.atan2(sun.z, sun.x) / (2 * Math.PI) + 0.5;
  const v = Math.asin(THREE.MathUtils.clamp(sun.y, -1, 1)) / Math.PI + 0.5;
  const i = (Math.floor((1 - v) * (height - 1)) * width + Math.floor(u * (width - 1))) * 4;
  const c = new THREE.Color(...[0, 1, 2].map((k) => (half ? THREE.DataUtils.fromHalfFloat((data as Uint16Array)[i + k]) : data[i + k])) as [number, number, number]);
  return c.multiplyScalar(1 / Math.max(c.r, c.g, c.b, 1e-6));
}

/** World direction for equirectangular texture coordinates (three.js's equirectUv, inverted). */
function direction(u: number, v: number): THREE.Vector3 {
  const azimuth = (u - 0.5) * 2 * Math.PI;
  const elevation = (v - 0.5) * Math.PI;
  return new THREE.Vector3(Math.cos(elevation) * Math.cos(azimuth), Math.sin(elevation), Math.cos(elevation) * Math.sin(azimuth));
}

function addRain(scene: THREE.Scene): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uCam: { value: new THREE.Vector3() } },
    vertexShader: /* glsl */ `
      uniform float uTime;
      uniform vec3 uCam;
      attribute float aEnd;
      void main() {
        vec3 p = position;
        p.y = mod(p.y - uTime * 26.0, ${RAIN_HEIGHT.toFixed(1)}) - 15.0 + uCam.y + aEnd * 0.9;
        p.xz = mod(p.xz - uCam.xz + ${(RAIN_BOX / 2).toFixed(1)}, ${RAIN_BOX.toFixed(1)}) - ${(RAIN_BOX / 2).toFixed(1)} + uCam.xz;
        p.x += aEnd * 0.1;
        gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      void main() { gl_FragColor = vec4(0.65, 0.72, 1.0, 0.25); }`,
    transparent: true,
    depthWrite: false,
  });
  const positions = new Float32Array(RAIN_DROPS * 6);
  const ends = new Float32Array(RAIN_DROPS * 2);
  for (let i = 0; i < RAIN_DROPS; i++) {
    const x = Math.random() * RAIN_BOX;
    const y = Math.random() * RAIN_HEIGHT;
    const z = Math.random() * RAIN_BOX;
    positions.set([x, y, z, x, y, z], i * 6);
    ends.set([0, 1], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aEnd', new THREE.BufferAttribute(ends, 1));
  const rain = new THREE.LineSegments(geo, material);
  rain.frustumCulled = false;
  scene.add(rain);
  return material;
}
