// Per-car handling data. Every car is a CarTuning value, so adding a car means adding data, not code.
// Units: meters, kilograms, newtons, radians, seconds. Chassis local axes: +X forward, +Y up, +Z right.

export interface CarTuning {
  name: string;
  className: string;
  paint: number;

  mass: number;
  chassisHalf: { x: number; y: number; z: number };
  centerOfMassY: number; // lower = harder to roll over

  wheelRadius: number;
  axleFront: number; // X position of the front axle
  axleRear: number;
  halfTrack: number; // Z distance from center to each wheel
  mountY: number; // suspension mount height relative to chassis center
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
  offroadGrip: number; // multiplier on grass

  maxSteer: number; // at low speed
  highSpeedSteer: number; // at topSpeed
  steerRate: number; // rad/s the front wheels can turn
  driftSteer: number; // steering authority on top of auto-alignment while drifting
  driftLock: number; // max front wheel angle while drifting (counter-steer lock)

  drag: number; // N per (m/s)^2
  offroadDrag: number; // N per m/s on grass
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

export const VESPER_GT: CarTuning = {
  name: 'Vesper GT',
  className: 'Sport',
  paint: 0xe8491d,

  mass: 1200,
  chassisHalf: { x: 2.05, y: 0.28, z: 0.88 },
  centerOfMassY: -0.3,

  wheelRadius: 0.36,
  axleFront: 1.3,
  axleRear: -1.25,
  halfTrack: 0.82,
  mountY: 0.05,
  suspensionRest: 0.3,
  suspensionTravel: 0.22,
  suspensionStiffness: 26,
  suspensionCompression: 2.6,
  suspensionRelaxation: 3.0,

  driveFront: false,
  driveRear: true,
  engineForce: 8400,
  topSpeed: 58,
  reverseForce: 4000,
  reverseTopSpeed: 12,
  brakeForce: 14000,
  handbrakeForce: 9000,
  coastBrake: 600,

  gripFront: 2.2,
  gripRear: 2.3,
  handbrakeGripRear: 0.9,
  driftGripRear: 1.35,
  driftSideStiffness: 0.75,
  offroadGrip: 0.7,

  maxSteer: 0.55,
  highSpeedSteer: 0.13,
  steerRate: 2.8,
  driftSteer: 0.3,
  driftLock: 0.9,

  drag: 0.55,
  offroadDrag: 70,
  downforce: 0.8,

  driftAngle: 0.45,
  driftAngleRange: 0.3,
  driftYawStiffness: 32000,
  driftYawDamping: 10000,
  driftMaxTorque: 24000,
  driftSustain: 6,

  boostForce: 9000,
  boostTopSpeed: 75,
};
