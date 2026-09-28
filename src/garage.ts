// The cars: real supercars converted from GTA V mods (scripts/convert-cars.mjs → public/mods/cars).
// Each mod's handling.meta (mass, drive force and bias, top speed, brakes, grip, steering lock) is
// mapped onto the arcade physics, so a Chiron and a Huracán feel different out of the box.
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { loadModCar, modCarVisual, type Template } from './modcar';
import { BASE, GARAGE, RIVAL_GARAGE, type CarTuning } from './tuning';

/** Garage order: number keys 1–9 pick the first nine (the pause menu lists them all). */
// Engine sounds come from sound mods of each car's own engine, or its closest relative
// (public/mods/audio): the Huracán's V10 is the Audi R8's; the P1 has its own twin-turbo V8 and the Jesko
// borrows it; the Huayra R's and the Valkyrie's naturally aspirated V12s are the LaFerrari's and the
// Aventador's; the Mopars (Chargers, Challenger) get the Hellcat's supercharged V8, the Chevrolets, Ford
// and Pontiac the small-block Corvette's.
// Muscle cars in their period colours: B5 Blue, Tuxedo Black, Cranberry Red, LeMans Blue, Plum Crazy,
// Wimbledon White, Carousel Red.
const CARS = [
  { id: 'lambo-huracan', paint: 0x6fbf1f, engine: 'audi-v10' },
  { id: 'koenigsegg-jesko', paint: 0xe8ebef, engine: 'hyper-v8' },
  { id: 'mclaren-p1', paint: 0xf26b1d, engine: 'hyper-v8' },
  { id: 'pagani-huayra-r', paint: 0x1c3f94, engine: 'ferrari-v12' },
  { id: 'aston-valkyrie', paint: 0x0f4a33, engine: 'lambo-v12' },
  { id: 'muscle-charger-69', paint: 0x2f6fc4, engine: 'muscle-v8' },
  { id: 'muscle-charger-dom-70', paint: 0x0c0c0e, engine: 'muscle-v8' },
  { id: 'muscle-chevelle-70', paint: 0x8a1522, engine: 'corvette-v8' },
  { id: 'muscle-camaro-69', paint: 0x173a8a, engine: 'corvette-v8' },
  { id: 'muscle-challenger-70', paint: 0x5b2a86, engine: 'muscle-v8' },
  { id: 'muscle-mustang-boss-69', paint: 0xe9e6dc, engine: 'corvette-v8' },
  { id: 'muscle-gto-judge-69', paint: 0xe25a1c, engine: 'corvette-v8' },
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
  const massRatio = mass / 1500;
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
    reverseForce: mass * 7.5,
    reverseTopSpeed: 16,
    brakeForce: mass * clamp((h.brakeForce ?? 1) * 20, 18, 26),
    handbrakeForce: mass * 11,
    gripFront: grip,
    gripRear: grip + 0.05,
    driftGripRear: grip * 0.52,
    handbrakeGripRear: 0.65,
    maxSteer: clamp(((h.steeringLock ?? 40) * Math.PI) / 180 * 1.3, 0.48, 0.64),
    highSpeedSteer: 0.20,
    steerRate: 3.8,
    driftYawStiffness: 48000 * massRatio,
    driftYawDamping: 22000 * massRatio,
    driftMaxTorque: 36000 * massRatio,
    driftSustain: 7.0,
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
