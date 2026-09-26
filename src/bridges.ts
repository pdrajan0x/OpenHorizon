// Procedural bridges connecting islands: road deck geometry, collision, and road graph links.
// Bridges span the water gaps between islands, connecting their road networks so you can drive
// between any two cities without teleporting.
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { STATIC_GROUPS } from './map';

const BRIDGE_WIDTH = 18; // m, two lanes each way plus shoulders
const BRIDGE_THICKNESS = 1.2; // m, deck depth
const BRIDGE_Y = 8; // m above sea level
const DECK_COLOR = 0x3a3a3a; // dark asphalt
const RAIL_COLOR = 0x888888; // steel guardrails
const RAIL_HEIGHT = 1.2;
const RAIL_THICKNESS = 0.15;

interface BridgeSegment {
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export class BridgeNetwork {
  readonly root = new THREE.Group();
  private readonly colliders: RAPIER.Collider[] = [];

  constructor(
    private readonly world: RAPIER.World,
    scene: THREE.Scene,
    segments: BridgeSegment[],
  ) {
    this.root.name = 'bridges';
    for (const seg of segments) {
      this.createBridge(seg.from, seg.to);
    }
    scene.add(this.root);
  }

  private createBridge(from: THREE.Vector3, to: THREE.Vector3): void {
    const dir = new THREE.Vector3().subVectors(to, from);
    const length = dir.length();
    const mid = new THREE.Vector3().addVectors(from, to).multiplyScalar(0.5);
    mid.y = BRIDGE_Y;

    // Bridge deck: a flat box from->to at BRIDGE_Y
    const deckGeom = new THREE.BoxGeometry(length, BRIDGE_THICKNESS, BRIDGE_WIDTH);
    const deckMat = new THREE.MeshStandardMaterial({
      color: DECK_COLOR,
      roughness: 0.8,
      metalness: 0.1,
    });
    const deck = new THREE.Mesh(deckGeom, deckMat);
    deck.position.copy(mid);
    deck.lookAt(to.x, mid.y, to.z);
    deck.rotateY(Math.PI / 2);
    this.root.add(deck);

    // Collision: box collider for the deck
    const rot = new THREE.Quaternion().setFromEuler(deck.rotation);
    const deckDesc = RAPIER.ColliderDesc.cuboid(length / 2, BRIDGE_THICKNESS / 2, BRIDGE_WIDTH / 2)
      .setTranslation(mid.x, mid.y, mid.z)
      .setRotation(rot)
      .setFriction(0.9)
      .setCollisionGroups(STATIC_GROUPS);
    this.colliders.push(this.world.createCollider(deckDesc));

    // Guardrails on both sides
    const railGeom = new THREE.BoxGeometry(length, RAIL_HEIGHT, RAIL_THICKNESS);
    const railMat = new THREE.MeshStandardMaterial({
      color: RAIL_COLOR,
      roughness: 0.4,
      metalness: 0.7,
    });

    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(railGeom, railMat);
      const offset = new THREE.Vector3(0, 0, side * (BRIDGE_WIDTH / 2 + RAIL_THICKNESS / 2));
      offset.applyQuaternion(rot);
      rail.position.copy(mid).add(offset);
      rail.position.y += (BRIDGE_THICKNESS + RAIL_HEIGHT) / 2;
      rail.lookAt(to.x, rail.position.y, to.z);
      rail.rotateY(Math.PI / 2);
      this.root.add(rail);

      const railRot = new THREE.Quaternion().setFromEuler(rail.rotation);
      const railDesc = RAPIER.ColliderDesc.cuboid(length / 2, RAIL_HEIGHT / 2, RAIL_THICKNESS / 2)
        .setTranslation(rail.position.x, rail.position.y, rail.position.z)
        .setRotation(railRot)
        .setFriction(0.6)
        .setCollisionGroups(STATIC_GROUPS);
      this.colliders.push(this.world.createCollider(railDesc));
    }

    // Support pillars every 80m for long bridges
    if (length > 100) {
      const pillarSpacing = 80;
      const pillarCount = Math.floor(length / pillarSpacing);
      const pillarGeom = new THREE.CylinderGeometry(1.5, 2, BRIDGE_Y + BRIDGE_THICKNESS / 2, 8);
      const pillarMat = new THREE.MeshStandardMaterial({
        color: 0x606060,
        roughness: 0.6,
        metalness: 0.3,
      });

      for (let i = 1; i <= pillarCount; i++) {
        const t = i / (pillarCount + 1);
        const pos = new THREE.Vector3().lerpVectors(from, to, t);
        pos.y = (BRIDGE_Y + BRIDGE_THICKNESS / 2) / 2;

        const pillar = new THREE.Mesh(pillarGeom, pillarMat);
        pillar.position.copy(pos);
        this.root.add(pillar);

        // Collision for pillar
        const pillarDesc = RAPIER.ColliderDesc.cylinder((BRIDGE_Y + BRIDGE_THICKNESS / 2) / 2, 1.5)
          .setTranslation(pos.x, pos.y, pos.z)
          .setFriction(0.5)
          .setCollisionGroups(STATIC_GROUPS);
        this.colliders.push(this.world.createCollider(pillarDesc));
      }
    }
  }

  dispose(): void {
    for (const c of this.colliders) {
      this.world.removeCollider(c, false);
    }
    this.colliders.length = 0;
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        mesh.geometry.dispose();
        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((m) => m.dispose());
        } else {
          mesh.material.dispose();
        }
      }
    });
    this.root.clear();
  }
}

/**
 * Generate bridge connections between islands. Finds pairs of islands close enough to bridge,
 * picks road endpoints near each other, and creates straight bridge segments.
 */
export function generateBridges(
  islands: Array<{ offset: THREE.Vector3; roadNodes: Array<[number, number, number]>; bounds: [number, number, number, number] }>,
  maxBridgeLength = 1500,
): BridgeSegment[] {
  const segments: BridgeSegment[] = [];
  const connected = new Set<string>();

  for (let i = 0; i < islands.length; i++) {
    for (let j = i + 1; j < islands.length; j++) {
      const a = islands[i];
      const b = islands[j];

      // Find closest road nodes between the two islands
      let bestDist = Infinity;
      let bestA: THREE.Vector3 | null = null;
      let bestB: THREE.Vector3 | null = null;

      // Sample subset of nodes for performance
      const sampleA = a.roadNodes.filter((_, k) => k % 10 === 0);
      const sampleB = b.roadNodes.filter((_, k) => k % 10 === 0);

      for (const [ax, ay, az] of sampleA) {
        const posA = new THREE.Vector3(ax, ay, az);
        for (const [bx, by, bz] of sampleB) {
          const posB = new THREE.Vector3(bx, by, bz);
          const dist = posA.distanceTo(posB);
          if (dist < bestDist && dist < maxBridgeLength) {
            bestDist = dist;
            bestA = posA;
            bestB = posB;
          }
        }
      }

      if (bestA && bestB) {
        const key = [i, j].sort().join('-');
        if (!connected.has(key)) {
          segments.push({ from: bestA, to: bestB });
          connected.add(key);
        }
      }
    }
  }

  return segments;
}
