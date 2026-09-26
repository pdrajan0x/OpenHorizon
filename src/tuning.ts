// Per-car handling data. Every car is a CarTuning value, so adding a car means adding data, not code.
// Units: meters, kilograms, newtons, radians, seconds. Chassis local axes: +X forward, +Y up, +Z right.
// The cars come from GTA V mods: garage.ts converts each mod's handling.meta into a CarTuning and
// supplies the visual (wheel positions and size, chassis box) from the converted model.
import type { CarVisual } from './modcar';

export interface CarTuning {
  name: string;
  className: string; // shown above the name, e.g. the make
  paint: number;
  underglow?: number;
  makeVisual: (t: CarTuning) => CarVisual; // the car's model, from a GTA V mod
  engineSound?: string; // engine sound set in public/mods/audio

  mass: number;
  centerOfMassHeight: number; // above the ground; lower = harder to roll over

  suspensionRest: number;
  suspensionTravel: number;
  suspensionStiffness: number; // Rapier scales this by chassis mass
  suspensionCompression: number;
  suspensionRelaxation: number;

  driveFront: boolean;
  driveRear: boolean;
  engineForce: number; // total at standstill, fades to 0 at topSpeed
  topSpeed: number;
  reverseForce: number;
  reverseTopSpeed: number;
  brakeForce: number; // total over all four wheels
  handbrakeForce: number; // total over the rear wheels
  coastBrake: number; // engine braking with no pedal input

  gripFront: number; // Rapier friction slip, roughly a tire friction coefficient
  gripRear: number;
  handbrakeGripRear: number;
  driftGripRear: number;
  driftSideStiffness: number; // rear lateral stiffness while drifting (1 = normal)

  maxSteer: number; // at low speed
  highSpeedSteer: number; // at topSpeed
  steerRate: number; // rad/s the front wheels can turn
  driftSteer: number; // steering authority on top of auto-alignment while drifting
  driftLock: number; // max front wheel angle while drifting (counter-steer lock)

  drag: number; // N per (m/s)^2
  downforce: number; // N per (m/s)^2

  // Arcade drift assists
  driftAngle: number; // slip angle (rad) held with no steering input
  driftAngleRange: number; // steering into the corner adds this much angle; counter-steer removes it
  driftYawStiffness: number; // N·m per radian of angle error
  driftYawDamping: number; // N·m per rad/s of slip change
  driftMaxTorque: number;
  driftSustain: number; // m/s^2 push along travel direction while drifting on throttle

  boostForce: number; // extra total drive force while boosting
  boostTopSpeed: number;
}

export const BASE = {
  suspensionRest: 0.3,
  suspensionTravel: 0.22,
  suspensionStiffness: 28,
  suspensionCompression: 2.8,
  suspensionRelaxation: 3.2,
  reverseForce: 10000,
  reverseTopSpeed: 16,
  brakeForce: 26000,
  handbrakeForce: 16000,
  coastBrake: 600,
  handbrakeGripRear: 0.65,
  driftSideStiffness: 0.65,
  steerRate: 3.8,
  driftSteer: 0.35,
  driftLock: 0.95,
  driftAngle: 0.38,
  driftAngleRange: 0.20,
  driftYawStiffness: 48000,
  driftYawDamping: 22000,
  driftMaxTorque: 36000,
  driftSustain: 7.0,
} satisfies Partial<CarTuning>;

/** The player's cars, filled by loadGarage() in garage.ts. */
export const GARAGE: CarTuning[] = [];
/** The same cars with light models (simplified mesh, small textures) for rivals. */
export const RIVAL_GARAGE: CarTuning[] = [];
