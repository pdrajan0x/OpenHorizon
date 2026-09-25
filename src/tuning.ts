// Per-car handling data. Every car is a CarTuning value, so adding a car means adding data, not code.
// Units: meters, kilograms, newtons, radians, seconds. Chassis local axes: +X forward, +Y up, +Z right.
// Geometry (wheel positions and size, chassis box) comes from the car's design in carModel.ts.
import { DESIGNS, type CarDesign } from './carModel';

export interface CarTuning {
  name: string;
  className: string;
  design: CarDesign;
  paint: number;
  underglow?: number;

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

const BASE = {
  suspensionRest: 0.3,
  suspensionTravel: 0.22,
  suspensionStiffness: 28,
  suspensionCompression: 2.8,
  suspensionRelaxation: 3.2,
  reverseForce: 5000,
  reverseTopSpeed: 12,
  handbrakeForce: 10000,
  coastBrake: 700,
  handbrakeGripRear: 0.9,
  driftSideStiffness: 0.75,
  steerRate: 2.8,
  driftSteer: 0.3,
  driftLock: 0.9,
  driftAngle: 0.45,
  driftAngleRange: 0.3,
  driftYawStiffness: 38000,
  driftYawDamping: 12000,
  driftMaxTorque: 28000,
  driftSustain: 6,
} satisfies Partial<CarTuning>;

/** Hypercar: lightest, fastest, most grip. */
export const VESPER_NYX: CarTuning = {
  ...BASE,
  name: 'Vesper Nyx',
  className: 'Hyper',
  design: DESIGNS.vesperNyx,
  paint: 0x2a48d8,
  underglow: 0x00e5ff,
  mass: 1350,
  centerOfMassHeight: 0.42,
  driveFront: true,
  driveRear: true,
  engineForce: 13500,
  topSpeed: 88,
  brakeForce: 19000,
  gripFront: 2.5,
  gripRear: 2.6,
  driftGripRear: 1.4,
  maxSteer: 0.55,
  highSpeedSteer: 0.1,
  drag: 0.5,
  downforce: 1.2,
  boostForce: 12000,
  boostTopSpeed: 105,
};

/** Grand tourer: balanced and planted. */
export const SOLACE_ARC: CarTuning = {
  ...BASE,
  name: 'Solace Arc',
  className: 'Super',
  design: DESIGNS.solaceArc,
  paint: 0xd02a38,
  underglow: 0xff2bd6,
  mass: 1520,
  centerOfMassHeight: 0.46,
  driveFront: false,
  driveRear: true,
  engineForce: 12500,
  topSpeed: 80,
  brakeForce: 18000,
  gripFront: 2.4,
  gripRear: 2.45,
  driftGripRear: 1.35,
  maxSteer: 0.55,
  highSpeedSteer: 0.11,
  drag: 0.52,
  downforce: 0.9,
  boostForce: 11000,
  boostTopSpeed: 96,
};

/** Muscle car: heavy, huge torque, happy to hang the tail out. */
export const IRONCLAD_BRUTE: CarTuning = {
  ...BASE,
  name: 'Ironclad Brute',
  className: 'Muscle',
  design: DESIGNS.ironcladBrute,
  paint: 0x1d1f24,
  underglow: 0xff8a00,
  mass: 1700,
  centerOfMassHeight: 0.5,
  driveFront: false,
  driveRear: true,
  engineForce: 14500,
  topSpeed: 74,
  brakeForce: 17000,
  gripFront: 2.2,
  gripRear: 2.05,
  driftGripRear: 1.25,
  maxSteer: 0.55,
  highSpeedSteer: 0.12,
  drag: 0.58,
  downforce: 0.6,
  boostForce: 12500,
  boostTopSpeed: 90,
  driftAngle: 0.5,
  driftAngleRange: 0.32,
};

export const GARAGE = [VESPER_NYX, SOLACE_ARC, IRONCLAD_BRUTE];
