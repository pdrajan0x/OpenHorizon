// The world: several cities from GTA V map mods, each its own island in one ocean. GTA map mods are
// built on GTA's sea at height 0, so their shores meet the ocean where their authors put them; the
// islands are only moved sideways, side by side with open water between them. Procedural bridges
// connect nearby islands. To the rest of the game this looks like one map: one road graph (the
// islands' graphs merged with bridge links), one spawn, one streaming loop.
import type RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { BridgeNetwork, generateBridges } from './bridges';
import { GameMap, RoadGraph, type RoadData } from './map';

const WATER_GAP = 900; // m of open sea between neighbouring islands
const ROW_WIDTH = 16000; // m before the layout starts a new row
const STREAM_MARGIN = 900; // m beyond an island's shore at which it starts streaming in

export interface IslandInfo {
  id: string;
  name: string;
  area?: string;
}

/** The default archipelago when there's no index of converted maps: the cities converted so far. */
const DEFAULT_ISLANDS: IslandInfo[] = [
  { id: 'chicago', name: 'Chicago', area: 'downtown' },
  { id: 'miami', name: 'Miami', area: 'coastal city' },
  { id: 'dubai-highway', name: 'Dubai Highway', area: 'desert highway' },
  { id: 'dubai-islands', name: 'Dubai Islands', area: 'coastal resort' },
  { id: 'fukuoka-expressway', name: 'Fukuoka', area: 'expressway' },
  { id: 'hong-kong', name: 'Hong Kong', area: 'hillside city' },
  { id: 'midnight-shuto', name: 'Shuto Expressway', area: 'expressway' },
  { id: 'monaco-gp', name: 'Monaco', area: 'coastal street circuit' },
  { id: 'nfsu2-bayview', name: 'Bayview', area: 'tuner city' },
  { id: 'shibuya', name: 'Shibuya', area: 'Japanese district' },
  { id: 'tokyo-shinjuku', name: 'Shinjuku', area: 'Japanese district' },
];

export class Islands {
  readonly root = new THREE.Group();
  readonly roads: RoadGraph;
  readonly spawn: THREE.Vector3;
  readonly bridges?: BridgeNetwork;

  private constructor(readonly maps: GameMap[], readonly info: IslandInfo[], world: RAPIER.World, scene: THREE.Scene) {
    for (const m of maps) this.root.add(m.root);
    this.root.name = 'islands';

    // Merge road graphs from all islands
    const merged: RoadData = { nodes: [], flags: [], links: [] };

    for (const m of maps) {
      const base = merged.nodes.length;
      merged.nodes.push(...m.roadData.nodes);
      merged.flags.push(...(m.roadData.flags ?? m.roadData.nodes.map(() => 0)));
      merged.links.push(...m.roadData.links.map(([a, b, ab, ba]) => [a + base, b + base, ab, ba] as [number, number, number, number]));
    }

    // Generate bridges and add bridge road nodes + links
    if (maps.length > 1) {
      console.log(`🌉 Generating bridges between ${maps.length} islands:`, maps.map((_, i) => `${i + 1}. ${info[i].name}`).join(', '));

      const islandData = maps.map((m) => ({
        offset: m.offset,
        roadNodes: m.roadData.nodes,
        bounds: GameMap.footprint(m.manifest) as [number, number, number, number],
      }));

      const bridgeSegments = generateBridges(islandData, 1500);

      if (bridgeSegments.length > 0) {
        console.log(`✅ Created ${bridgeSegments.length} bridges connecting the islands`);
        // Create bridge geometry and collision
        this.bridges = new BridgeNetwork(world, scene, bridgeSegments);

        // Add bridge road nodes and links to the merged graph
        for (const seg of bridgeSegments) {
          // Find nearest road nodes on each island to the bridge endpoints
          let bestAIdx = 0;
          let bestBIdx = 0;
          let bestADist = Infinity;
          let bestBDist = Infinity;

          for (let i = 0; i < merged.nodes.length; i++) {
            const [x, y, z] = merged.nodes[i];
            const pos = new THREE.Vector3(x, y, z);
            const distA = pos.distanceTo(seg.from);
            const distB = pos.distanceTo(seg.to);

            if (distA < bestADist) {
              bestADist = distA;
              bestAIdx = i;
            }
            if (distB < bestBDist) {
              bestBDist = distB;
              bestBIdx = i;
            }
          }

          // Add bridge road nodes at endpoints
          const bridgeNodeA = merged.nodes.length;
          merged.nodes.push([seg.from.x, seg.from.y, seg.from.z]);
          merged.flags.push(0);

          const bridgeNodeB = merged.nodes.length;
          merged.nodes.push([seg.to.x, seg.to.y, seg.to.z]);
          merged.flags.push(0);

          // Link bridge endpoints to nearest island road nodes (bidirectional, 2 lanes each way)
          merged.links.push([bestAIdx, bridgeNodeA, 2, 2]);
          merged.links.push([bridgeNodeB, bestBIdx, 2, 2]);

          // Link bridge road nodes to each other (bidirectional)
          merged.links.push([bridgeNodeA, bridgeNodeB, 2, 2]);
        }
      }
    }

    this.roads = new RoadGraph(merged);
    this.spawn = maps[0].spawn.clone();
  }

  /**
   * Load the islands. `only` loads a single map on its own (tests, ?map=<id>); otherwise every city in
   * public/mods/maps/index.json (or the default list) is placed, first in the list is where you start.
   */
  static async load(world: RAPIER.World, scene: THREE.Scene, only?: string): Promise<Islands> {
    let list: IslandInfo[] = only ? [{ id: only, name: only }] : await fetch('/mods/maps/index.json')
      .then((r) => (r.ok ? (r.json() as Promise<IslandInfo[]>) : DEFAULT_ISLANDS))
      .catch(() => DEFAULT_ISLANDS);
    list = list.filter((i) => !i.id.startsWith('bridge-'));
    const data = (await Promise.all(list.map((i) => GameMap.fetchData(i.id).catch(() => null))));
    const loaded = list.map((info, k) => ({ info, data: data[k] })).filter((x) => x.data && x.data.roads.nodes.length > 0);

    // The first island stays where its converter put it (centred on the origin, where float precision is
    // best); the others follow in rows along +X with open sea between them
    const maps: GameMap[] = [];
    let x = 0;
    let rowZ = 0;
    let rowDepth = 0;
    let rowStart = 0;
    for (const [k, { info, data }] of loaded.entries()) {
      const [minX, minZ, maxX, maxZ] = GameMap.footprint(data!.manifest);
      const w = maxX - minX;
      const d = maxZ - minZ;
      if (k === 0) {
        maps.push(GameMap.from(info.id, data!, world, new THREE.Vector3()));
        x = maxX + WATER_GAP;
        rowStart = minX;
        rowZ = minZ;
        rowDepth = d;
        continue;
      }
      if (x + w - rowStart > ROW_WIDTH) {
        x = rowStart;
        rowZ += rowDepth + WATER_GAP;
        rowDepth = 0;
      }
      maps.push(GameMap.from(info.id, data!, world, new THREE.Vector3(x - minX, 0, rowZ - minZ)));
      x += w + WATER_GAP;
      rowDepth = Math.max(rowDepth, d);
    }
    return new Islands(maps, loaded.map((l) => l.info), world, scene);
  }

  /** The island a point is on (or nearest to). */
  islandAt(p: THREE.Vector3): { map: GameMap; info: IslandInfo } {
    let best = 0;
    let bestD = Infinity;
    this.maps.forEach((m, i) => {
      const d = m.distanceTo(p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return { map: this.maps[best], info: this.info[best] };
  }

  async prime(at: THREE.Vector3): Promise<void> {
    await Promise.all(this.maps.filter((m) => m.distanceTo(at) < STREAM_MARGIN).map((m) => m.prime(at)));
  }

  update(camera: THREE.Vector3, solid: THREE.Vector3[]): void {
    for (const m of this.maps) {
      const near = m.distanceTo(camera) < STREAM_MARGIN || solid.some((p) => m.distanceTo(p) < STREAM_MARGIN);
      if (near || m.active) m.update(camera, solid);
    }
  }

  cull(camera: THREE.Vector3): void {
    for (const m of this.maps) if (m.active) m.cull(camera);
  }

  setNight(amount: number): void {
    for (const m of this.maps) m.setNight(amount);
  }

  get loadedCells(): number {
    return this.maps.reduce((s, m) => s + m.loadedCells, 0);
  }

  /** Every island's shore-to-shore rectangle, for the minimap and the big map. */
  footprints(): { name: string; min: THREE.Vector2; max: THREE.Vector2 }[] {
    return this.maps.map((m, i) => ({ name: this.info[i].name, min: m.min, max: m.max }));
  }
}
