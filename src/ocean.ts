// The sea between the islands, at GTA's sea level (height 0), drawn the way GTA draws water: a flat
// surface given its waves by a normal map (public/mods/water/waternormals.jpg, fetched by
// scripts/fetch-environment.mjs) and its colour by reflecting the sky.
import * as THREE from 'three';

export const SEA_LEVEL = 0;
const SIZE = 60000; // m across; it rides with the camera
const WAVE_TILE = 24; // m per repeat of the normal map
const WAVE_SPEED = 0.012; // normal-map repeats per second
const RIPPLE_TILE = 5; // m per repeat of the ripples on top: they break the sun's glint into sparkles
const RIPPLE_SPEED = 0.05;

export class Ocean {
  private readonly mesh: THREE.Mesh;
  private readonly normals: THREE.Texture;
  private readonly ripples: THREE.Texture;

  private constructor(scene: THREE.Scene, normals: THREE.Texture) {
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    normals.repeat.set(SIZE / WAVE_TILE, SIZE / WAVE_TILE);
    normals.anisotropy = 8;
    this.normals = normals;
    // Swell on the base layer, sharp ripples on the coat: a smooth sea under the sun is one blinding
    // blob; ripples make it a path of glints
    const ripples = normals.clone();
    ripples.repeat.set(SIZE / RIPPLE_TILE, SIZE / RIPPLE_TILE);
    this.ripples = ripples;
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x06303f,
      roughness: 0.22,
      metalness: 0,
      normalMap: normals,
      normalScale: new THREE.Vector2(0.45, 0.45),
      clearcoat: 0.5,
      clearcoatRoughness: 0.02,
      clearcoatNormalMap: ripples,
      clearcoatNormalScale: new THREE.Vector2(0.6, 0.6),
    });
    const geo = new THREE.PlaneGeometry(SIZE, SIZE);
    geo.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.position.y = SEA_LEVEL;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'ocean';
    scene.add(this.mesh);
  }

  static async load(scene: THREE.Scene): Promise<Ocean> {
    const normals = await new THREE.TextureLoader().loadAsync('/mods/water/waternormals.jpg');
    return new Ocean(scene, normals);
  }

  update(time: number, camera: THREE.Vector3): void {
    // Follow the camera in whole wave tiles so the waves stay put in the world
    this.mesh.position.x = Math.round(camera.x / WAVE_TILE) * WAVE_TILE;
    this.mesh.position.z = Math.round(camera.z / WAVE_TILE) * WAVE_TILE;
    this.normals.offset.set(time * WAVE_SPEED, time * WAVE_SPEED * 0.6);
    this.ripples.offset.set(-time * RIPPLE_SPEED * 0.7, time * RIPPLE_SPEED);
  }
}
