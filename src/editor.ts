// Fix mode (E): the game stops and a free camera flies over the city; click a piece to select it and delete
// it, make it solid or make it passable. Fixes go into each city's edits.json (map.ts applies them whenever
// the city loads; the dev and play servers save them: vite.config.ts), so they last.
//
//   fly     W A S D, Space up, C down, Shift fast, mouse wheel: speed; drag the mouse to look
//   select  click a piece (a connected part of a mesh: a building, a wall, a sign); Shift+click adds more
//   fix     X delete (not drawn, not solid) · K make solid · N make passable · Z undo the last fix
//           T put the car on the road nearest the camera · E or Esc back to driving
import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { Islands } from './islands';
import type { Edit, GameMap } from './map';

const SPEED = 30; // m/s flying
const LOOK = 0.004; // rad per pixel dragged
const PICK_RANGE = 800; // m
const CLICK_SLOP = 5; // px a click may move and still be a click

interface Piece {
  map: GameMap;
  cell: number;
  mesh: string;
  box: [number, number, number, number, number, number]; // map frame
  helper: THREE.Box3Helper;
}

/** Per geometry, which piece each triangle belongs to (triangles joined by shared corners, welded by position). */
const piecesOf = new WeakMap<THREE.BufferGeometry, Int32Array>();

function pieceIds(g: THREE.BufferGeometry): Int32Array {
  let ids = piecesOf.get(g);
  if (ids) return ids;
  const pos = g.attributes.position;
  const idx = g.index!;
  const tris = Math.floor(idx.count / 3);
  const parent = new Int32Array(tris).map((_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; };
  const corner = new Map<string, number>();
  for (let t = 0; t < tris; t++) {
    for (let k = 0; k < 3; k++) {
      const i = idx.getX(t * 3 + k);
      const key = `${Math.round(pos.getX(i) * 20)},${Math.round(pos.getY(i) * 20)},${Math.round(pos.getZ(i) * 20)}`;
      const other = corner.get(key);
      if (other === undefined) corner.set(key, t); else parent[find(t)] = find(other);
    }
  }
  ids = new Int32Array(tris);
  for (let t = 0; t < tris; t++) ids[t] = find(t);
  piecesOf.set(g, ids);
  return ids;
}

export class Editor {
  open = false;
  private readonly pos = new THREE.Vector3();
  private yaw = 0;
  private pitch = 0;
  private speed = SPEED;
  private readonly held = new Set<string>();
  private readonly selected: Piece[] = [];
  /** Per fix applied: which map and how many edits, for undo. */
  private readonly history: { map: GameMap; count: number }[] = [];
  private readonly panel: HTMLDivElement;
  private drag: { x: number; y: number; moved: boolean } | null = null;
  private status = '';
  private shown = '';

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly canvas: HTMLCanvasElement,
    private readonly islands: Islands,
    private readonly placeCar: (at: THREE.Vector3) => void,
  ) {
    this.panel = document.createElement('div');
    this.panel.id = 'editor';
    this.panel.className = 'hidden';
    document.body.appendChild(this.panel);
    window.addEventListener('keydown', (e) => {
      if (!this.open) return;
      this.held.add(e.code);
      if (e.code === 'KeyX' || e.code === 'Delete') void this.fix('delete');
      else if (e.code === 'KeyK') void this.fix('solid');
      else if (e.code === 'KeyN') void this.fix('passable');
      else if (e.code === 'KeyZ') void this.undo();
      else if (e.code === 'KeyT') { this.placeCar(this.pos.clone()); this.say('Car put on the road nearest the camera'); }
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.open || e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
    });
    window.addEventListener('pointermove', (e) => {
      if (!this.open || !this.drag) return;
      const dx = e.clientX - this.drag.x;
      const dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(dx, dy) < CLICK_SLOP) return;
      this.drag.moved = true;
      this.yaw += e.movementX * LOOK;
      this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * LOOK, -1.5, 1.5);
    });
    window.addEventListener('pointerup', (e) => {
      if (!this.open || !this.drag) return;
      const click = !this.drag.moved;
      this.drag = null;
      if (click) this.pick(e.clientX, e.clientY, e.shiftKey);
    });
    canvas.addEventListener('wheel', (e) => {
      if (!this.open) return;
      this.speed = THREE.MathUtils.clamp(this.speed * (e.deltaY < 0 ? 1.25 : 0.8), 3, 400);
      this.say(`Flying speed ${this.speed.toFixed(0)} m/s`);
    }, { passive: true });
  }

  /** Into fix mode from where the camera is, or back to driving. */
  toggle(): void {
    this.open = !this.open;
    this.panel.classList.toggle('hidden', !this.open);
    this.held.clear();
    if (this.open) {
      this.pos.copy(this.camera.position);
      const d = this.camera.getWorldDirection(new THREE.Vector3());
      this.yaw = Math.atan2(d.z, d.x);
      this.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
      this.say('Click a piece to select it');
    } else {
      this.clearSelection();
    }
  }

  /** Fly the camera (call each frame while open). */
  update(dt: number): void {
    const dir = new THREE.Vector3(Math.cos(this.pitch) * Math.cos(this.yaw), Math.sin(this.pitch), Math.cos(this.pitch) * Math.sin(this.yaw));
    const right = new THREE.Vector3(-Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const k = this.speed * (this.held.has('ShiftLeft') || this.held.has('ShiftRight') ? 4 : 1) * dt;
    const h = (c: string) => (this.held.has(c) ? 1 : 0);
    this.pos.addScaledVector(dir, (h('KeyW') + h('ArrowUp') - h('KeyS') - h('ArrowDown')) * k);
    this.pos.addScaledVector(right, (h('KeyD') + h('ArrowRight') - h('KeyA') - h('ArrowLeft')) * k);
    this.pos.y += (h('Space') - h('KeyC')) * k;
    this.camera.position.copy(this.pos);
    this.camera.lookAt(this.pos.clone().add(dir));
    this.camera.fov = 60;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  // ------------------------------------------------------------------ picking

  /** The city piece under a screen point: select it (or add it, with Shift). */
  private pick(x: number, y: number, add: boolean): void {
    const rect = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    let best: { mesh: THREE.Mesh; face: number; distance: number } | null = null;
    const local = new THREE.Ray();
    const inv = new THREE.Matrix4();
    const sphere = new THREE.Sphere();
    this.islands.root.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as THREE.InstancedMesh).isInstancedMesh || !/^cell \d+$/.test(m.parent?.name ?? '')) return;
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g.index || !g.attributes.position) return;
      if (!g.boundingSphere) g.computeBoundingSphere();
      sphere.copy(g.boundingSphere!).applyMatrix4(m.matrixWorld);
      if (!ray.ray.intersectsSphere(sphere) || ray.ray.origin.distanceTo(sphere.center) - sphere.radius > PICK_RANGE) return;
      g.boundsTree ??= new MeshBVH(g);
      inv.copy(m.matrixWorld).invert();
      local.copy(ray.ray).applyMatrix4(inv);
      const hit = g.boundsTree.raycastFirst(local, THREE.DoubleSide);
      if (!hit || hit.faceIndex == null) return;
      const distance = hit.point.applyMatrix4(m.matrixWorld).distanceTo(ray.ray.origin);
      if (distance > PICK_RANGE || (best && distance >= best.distance)) return;
      best = { mesh: m, face: hit.faceIndex, distance };
    });
    if (!add) this.clearSelection();
    if (!best) { this.say('Nothing to select there (only the cities can be fixed)'); return; }
    const { mesh, face } = best as { mesh: THREE.Mesh; face: number };
    const map = this.islands.maps.find((mp) => mp.root === mesh.parent?.parent);
    if (!map) return;
    // The piece: every triangle joined to the one clicked
    const g = mesh.geometry;
    const ids = pieceIds(g);
    const id = ids[face];
    const pos = g.attributes.position;
    const idx = g.index!;
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    let tris = 0;
    for (let t = 0; t < ids.length; t++) {
      if (ids[t] !== id) continue;
      tris++;
      for (let k = 0; k < 3; k++) box.expandByPoint(v.fromBufferAttribute(pos, idx.getX(t * 3 + k)));
    }
    const cell = Number(/^cell (\d+)$/.exec(mesh.parent!.name)![1]);
    const world = box.clone().applyMatrix4(mesh.matrixWorld);
    const helper = new THREE.Box3Helper(world, 0xffd400);
    (helper.material as THREE.LineBasicMaterial).depthTest = false;
    helper.renderOrder = 10;
    this.scene.add(helper);
    const r = (n: number) => +n.toFixed(2);
    this.selected.push({
      map, cell, mesh: mesh.name, helper,
      box: [r(box.min.x), r(box.min.y), r(box.min.z), r(box.max.x), r(box.max.y), r(box.max.z)],
    });
    const size = box.getSize(new THREE.Vector3());
    this.say(`Selected: ${mesh.name.split(':')[1] ?? mesh.name}, ${tris} triangles, ${size.x.toFixed(0)} × ${size.y.toFixed(0)} × ${size.z.toFixed(0)} m (${this.selected.length} selected)`);
  }

  private clearSelection(): void {
    for (const p of this.selected) {
      this.scene.remove(p.helper);
      p.helper.geometry.dispose();
    }
    this.selected.length = 0;
  }

  // ------------------------------------------------------------------ fixing

  private async fix(op: Edit['op']): Promise<void> {
    if (!this.selected.length) { this.say('Select something first (click it)'); return; }
    const byMap = new Map<GameMap, Edit[]>();
    for (const p of this.selected) {
      const list = byMap.get(p.map) ?? [];
      list.push({ op, cell: p.cell, mesh: p.mesh, box: p.box });
      byMap.set(p.map, list);
    }
    const n = this.selected.length;
    this.clearSelection();
    let saved = true;
    for (const [map, list] of byMap) {
      await map.applyEdits(list);
      this.history.push({ map, count: list.length });
      saved = (await map.saveEdits()) && saved;
    }
    const what = op === 'delete' ? 'Deleted' : op === 'solid' ? 'Made solid' : 'Made passable';
    this.say(`${what}: ${n} piece${n === 1 ? '' : 's'}${saved ? ' · saved' : ' · NOT saved (run the game with npm run play or dev)'}`);
  }

  private async undo(): Promise<void> {
    const last = this.history.pop();
    if (!last) { this.say('Nothing to undo'); return; }
    await last.map.undoEdits(last.count);
    const saved = await last.map.saveEdits();
    this.say(`Undone${saved ? ' · saved' : ''}`);
  }

  // ------------------------------------------------------------------ panel

  private say(text: string): void {
    this.status = text;
    this.render();
  }

  private render(): void {
    if (!this.open) return;
    const here = this.islands.islandAt(this.pos);
    const edits = here.map.edits.length;
    const html = `<b>FIX MODE</b> · ${here.info.name} · ${edits} fix${edits === 1 ? '' : 'es'} here<br>
      <span>${this.status}</span><br>
      <small>Click select · Shift+click add · <b>X</b> delete · <b>K</b> solid · <b>N</b> passable · <b>Z</b> undo · <b>T</b> car here · <b>E</b>/<b>Esc</b> drive<br>
      Fly: <b>WASD</b> · <b>Space</b>/<b>C</b> up/down · <b>Shift</b> fast · wheel speed · drag to look</small>`;
    if (html !== this.shown) this.panel.innerHTML = this.shown = html;
  }
}
