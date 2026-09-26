// The cars: real supercars converted from GTA V mods (scripts/convert-cars.mjs → public/mods/cars).
// Each mod's handling.meta (mass, drive force and bias, top speed, brakes, grip, steering lock) is
// mapped onto the arcade physics, so a Chiron and a Huracán feel different out of the box.
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { loadModCar, modCarVisual, type Template } from './modcar';
import { BASE, GARAGE, RIVAL_GARAGE, type CarTuning } from './tuning';

/** Garage order: number keys 1–9 pick these. */
// Engine sounds come from sound mods of the closest real engines (public/mods/audio)
const CARS = [
  { id: 'lambo-huracan', paint: 0x6fbf1f, engine: 'lambo-v12' },
  { id: 'ferrari-sf90', paint: 0xc4121c, engine: 'ferrari-v8' },
  { id: 'bugatti-chiron', paint: 0x1f4fbf, engine: 'hyper-v8' },
  { id: 'lambo-centenario', paint: 0x2a2d33, engine: 'lambo-v12' },
  { id: 'ferrari-812', paint: 0xd8d8dc, engine: 'ferrari-v12' },
  { id: 'bugatti-divo', paint: 0x3fa9d6, engine: 'hyper-v8' },
  { id: 'lambo-terzo', paint: 0xe8e8ec, engine: 'lambo-v12' },
  { id: 'ferrari-fxxk', paint: 0xcf1a1a, engine: 'ferrari-v12' },
  { id: 'bugatti-bolide', paint: 0x14161c, engine: 'hyper-v8' },
];

interface Spec {
  id: string;
  name: string;
  make: string;
  handling: {
    mass?: number;
    driveBiasFront?: number;
    driveForce?: number;
    maxFlatVel?: number;
    brakeForce?: number;
    steeringLock?: number;
    tractionMax?: number;
  } | null;
}

const clamp = THREE.MathUtils.clamp;
const heroTemplates = new Map<string, Template>();
const lodTemplates = new Map<string, Template>();

/** GTA handling units → the arcade model. GTA values are tuned for its own physics, so clamp to what drives well here. */
function tuningFor(spec: Spec, paint: number, engine: string, template: () => Template): CarTuning {
  const h = spec.handling ?? {};
  const mass = clamp(h.mass ?? 1500, 1100, 2300);
  const bias = h.driveBiasFront ?? 0.3;
  const top = clamp(((h.maxFlatVel ?? 300) / 3.6) * 0.95, 60, 95); // m/s
  const accel = clamp((h.driveForce ?? 0.33) * 9.81 * 2.8, 7.5, 12.5); // m/s² from standstill
  const grip = clamp((h.tractionMax ?? 2.5) * 0.95, 2.2, 2.7);
  return {
    ...BASE,
    name: spec.name,
    className: spec.make,
    paint,
    engineSound: engine,
    makeVisual: (t) => modCarVisual(template(), { paint: t.paint }),
    mass,
    centerOfMassHeight: 0.44,
    driveFront: bias > 0.1,
    driveRear: bias < 0.9,
    engineForce: mass * accel,
    topSpeed: top,
    brakeForce: mass * clamp((h.brakeForce ?? 1) * 12, 10, 15),
    gripFront: grip,
    gripRear: grip + 0.05,
    driftGripRear: grip * 0.55,
    maxSteer: clamp(((h.steeringLock ?? 40) * Math.PI) / 180 * 1.3, 0.45, 0.62),
    highSpeedSteer: 0.1,
    drag: 0.5,
    downforce: 1.0,
    boostForce: mass * accel * 0.9,
    boostTopSpeed: top * 1.2,
  };
}

/** Fetch the car list and the light rival models, and the first hero model. */
export async function loadGarage(first = 0): Promise<void> {
  const specs = await Promise.all(CARS.map((c) => fetch(`/mods/cars/${c.id}.json`).then((r) => r.json() as Promise<Spec>)));
  await Promise.all(CARS.map(async (c) => lodTemplates.set(c.id, await loadModCar(`/mods/cars/${c.id}_lod.glb`))));
  CARS.forEach((c, i) => {
    GARAGE.push(tuningFor(specs[i], c.paint, c.engine, () => heroTemplates.get(c.id) ?? lodTemplates.get(c.id)!));
    RIVAL_GARAGE.push(tuningFor(specs[i], c.paint, c.engine, () => lodTemplates.get(c.id)!));
  });
  await ensureHero(first);
}

/** Load a garage car's full-detail model (the light one stands in until it arrives). */
export async function ensureHero(index: number): Promise<void> {
  const id = CARS[index]?.id;
  if (id && !heroTemplates.has(id)) heroTemplates.set(id, await loadModCar(`/mods/cars/${id}.glb`));
}

const TRAFFIC = [
  { id: 'traffic-camry', taxi: false },
  { id: 'traffic-civic', taxi: false },
  { id: 'traffic-passat', taxi: false },
  { id: 'traffic-prius', taxi: true },
  { id: 'traffic-crownvic', taxi: true },
  { id: 'traffic-landcruiser', taxi: false },
  { id: 'traffic-f150', taxi: false },
  { id: 'traffic-sprinter', taxi: false },
];

/** The everyday cars for ambient traffic (light models). */
export async function loadTrafficModels(): Promise<{ template: Template; taxi: boolean }[]> {
  await MeshoptSimplifier.ready; // traffic simplifies its merged meshes when the fleet is built
  return Promise.all(TRAFFIC.map(async (t) => ({ template: await loadModCar(`/mods/cars/${t.id}_lod.glb`), taxi: t.taxi })));
}
