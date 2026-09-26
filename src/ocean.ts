// The sea between the islands, at GTA's sea level (height 0), drawn the way GTA draws water: a flat
// surface given its waves by a normal map (public/mods/water/waternormals.jpg, fetched by
// scripts/fetch-environment.mjs) and its colour by reflecting the sky.
import * as THREE from 'three';

export const SEA_LEVEL = 0;
const SIZE = 60000; // m across; it rides with the camera
const WAVE_TILE = 24; // m per repeat of the normal map
const WAVE_SPEED = 0.012; // normal-map repeats per second

export class Ocean {
  private readonly mesh: THREE.Mesh;
  private readonly normals: THREE.Texture;

  private constructor(scene: THREE.Scene, normals: THREE.Texture) {
    normals.wrapS = normals.wrapT = THREE.RepeatWrapping;
    normals.repeat.set(SIZE / WAVE_TILE, SIZE / WAVE_TILE);
    normals.anisotropy = 8;
    this.normals = normals;
    const material = new THREE.MeshPhysicalMaterial({
      color: 0x06303f,
      roughness: 0.06,
      metalness: 0,
      normalMap: normals,
      normalScale: new THREE.Vector2(0.45, 0.45),
      clearcoat: 0.6,
      clearcoatRoughness: 0.1,
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
  }
}
