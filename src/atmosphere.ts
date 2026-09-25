import * as THREE from 'three';

const HORIZON = 0x2b1a3d;
const FOG_DENSITY = 0.0026;
const RAIN_DROPS = 6000;
const RAIN_BOX = 120; // meters around the camera
const RAIN_HEIGHT = 60;

/** Night sky, haze, ambient light and rain. */
export class Atmosphere {
  private readonly rain: THREE.ShaderMaterial;

  constructor(scene: THREE.Scene) {
    scene.background = new THREE.Color(HORIZON);
    scene.fog = new THREE.FogExp2(HORIZON, FOG_DENSITY);
    scene.add(skyDome());
    scene.add(new THREE.HemisphereLight(0x6a5aa0, 0x0c0816, 0.9));
    const moon = new THREE.DirectionalLight(0x8a96ff, 0.5);
    moon.position.set(-200, 400, 150);
    scene.add(moon);

    this.rain = new THREE.ShaderMaterial({
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
    const rain = new THREE.LineSegments(geo, this.rain);
    rain.frustumCulled = false;
    scene.add(rain);
  }

  update(time: number, camera: THREE.Vector3): void {
    this.rain.uniforms.uTime.value = time;
    this.rain.uniforms.uCam.value.copy(camera);
  }

  /** Photograph the lit city into an environment map, so glossy paint and wet asphalt reflect it. */
  captureEnvironment(renderer: THREE.WebGLRenderer, scene: THREE.Scene, at: THREE.Vector3): void {
    const target = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
    const camera = new THREE.CubeCamera(1, 3000, target);
    camera.position.copy(at);
    camera.update(renderer, scene);
    scene.environment = new THREE.PMREMGenerator(renderer).fromCubemap(target.texture).texture;
    scene.environmentIntensity = 1.2;
    target.dispose();
  }
}

function skyDome(): THREE.Mesh {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      top: { value: new THREE.Color(0x05050f) },
      mid: { value: new THREE.Color(0x160f2e) },
      horizon: { value: new THREE.Color(HORIZON) },
      glow: { value: new THREE.Color(0x6a2a5e) },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 top, mid, horizon, glow;
      varying vec3 vDir;
      void main() {
        float h = vDir.y;
        vec3 c = mix(horizon, mid, smoothstep(0.0, 0.25, h));
        c = mix(c, top, smoothstep(0.25, 0.8, h));
        c += glow * exp(-abs(h) * 12.0) * 0.6; // light pollution just above the skyline
        gl_FragColor = vec4(c, 1.0);
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), material);
  dome.renderOrder = -1;
  return dome;
}
