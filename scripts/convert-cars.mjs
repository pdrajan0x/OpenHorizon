// Converts the hero car mods listed below into raw .build/cars/<id>.glb files (then run
// scripts/optimize-models.mjs to make the game's public/mods/cars/<id>.glb and <id>_lod.glb), plus
// public/mods/cars/<id>.json with the mod's GTA handling values. Mods are fetched into .mods/ by
// scripts/fetch-mods.mjs (dlc.rpf archives are unpacked first with `gta5conv rpf`).
// Usage: node scripts/convert-cars.mjs [id ...]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CARS = [
  { id: 'lambo-terzo', mod: 'lambo-terzo-millennio', model: 'ocnlamtmc', name: 'Terzo Millennio', make: 'Lamborghini' },
  { id: 'lambo-huracan', mod: 'lambo-huracan-performante', model: 'vacca', name: 'Huracán Performante', make: 'Lamborghini' },
  { id: 'lambo-centenario', mod: 'lambo-centenario', model: 'lp770', name: 'Centenario', make: 'Lamborghini' },
  { id: 'ferrari-sf90', mod: 'ferrari-sf90', model: 'sf90', name: 'SF90 Stradale', make: 'Ferrari' },
  { id: 'ferrari-812', mod: 'ferrari-812-superfast', model: 'italigtb2', name: '812 Superfast', make: 'Ferrari' },
  { id: 'ferrari-fxxk', mod: 'ferrari-fxx-k', model: 'fxxk', name: 'FXX-K', make: 'Ferrari' },
  { id: 'bugatti-chiron', mod: 'bugatti-chiron', model: 'nero', name: 'Chiron', make: 'Bugatti' },
  { id: 'bugatti-divo', mod: 'bugatti-divo', model: 'divo', name: 'Divo', make: 'Bugatti' },
  { id: 'bugatti-bolide', mod: 'bugatti-bolide', model: 'bolide', name: 'Bolide', make: 'Bugatti' },
  // Everyday traffic
  { id: 'traffic-prius', mod: 'traffic-prius-taxi', model: 'priustaxi', name: 'Prius Taxi', make: 'Toyota' },
  { id: 'traffic-crownvic', mod: 'traffic-crownvic-taxi', model: 'taxi', name: 'Crown Victoria Taxi', make: 'Ford' },
  { id: 'traffic-camry', mod: 'traffic-camry', model: 'camry18', name: 'Camry', make: 'Toyota' },
  { id: 'traffic-passat', mod: 'traffic-passat', model: 'passat', name: 'Passat', make: 'Volkswagen' },
  { id: 'traffic-civic', mod: 'traffic-civic', model: 'premier', name: 'Civic', make: 'Honda' },
  { id: 'traffic-landcruiser', mod: 'traffic-landcruiser', model: 'lc200', name: 'Land Cruiser', make: 'Toyota' },
  { id: 'traffic-f150', mod: 'traffic-f150-raptor', model: 'f150', name: 'F-150 Raptor', make: 'Ford' },
  { id: 'traffic-sprinter', mod: 'traffic-sprinter', model: 'sprinter211', name: 'Sprinter', make: 'Mercedes-Benz' },
];
const CONV = 'tools/gta5conv/bin/Release/net10.0/gta5conv.dll';
const RAW = '.build/cars';
const OUT = 'public/mods/cars';

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Unpack any dlc.rpf that hasn't been unpacked yet, so loose files are available. */
function unpack(modDir) {
  for (const f of walk(modDir)) {
    if (!f.endsWith('dlc.rpf') || f.includes('/rpf/')) continue;
    const dest = join(modDir, 'rpf');
    if (!existsSync(dest)) execFileSync('dotnet', [CONV, 'rpf', f, dest], { stdio: 'inherit' });
  }
}

/** Numbers from the mod's handling.meta item for this model (first item when names don't match). */
function handling(files, model) {
  const metas = files.filter((f) => f.toLowerCase().endsWith('handling.meta'));
  for (const f of metas) {
    const xml = readFileSync(f, 'utf8');
    const items = xml.split(/<Item type="CHandlingData">/).slice(1);
    const item = items.find((i) => new RegExp(`<handlingName>\\s*${model}\\s*<`, 'i').test(i)) ?? items[0];
    if (!item) continue;
    const num = (tag) => {
      const m = item.match(new RegExp(`<${tag} value="([-0-9.]+)"`));
      return m ? Number(m[1]) : undefined;
    };
    return {
      mass: num('fMass'),
      driveBiasFront: num('fDriveBiasFront'),
      driveForce: num('fInitialDriveForce'),
      maxFlatVel: num('fInitialDriveMaxFlatVel'),
      brakeForce: num('fBrakeForce'),
      steeringLock: num('fSteeringLock'),
      tractionMax: num('fTractionCurveMax'),
      tractionMin: num('fTractionCurveMin'),
      gears: num('nInitialDriveGears'),
    };
  }
  return null;
}

mkdirSync(RAW, { recursive: true });
mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const car of CARS.filter((c) => only.length === 0 || only.includes(c.id))) {
  const dir = join('.mods', car.mod);
  if (!existsSync(dir)) {
    console.log(`skip ${car.id}: ${dir} not downloaded`);
    continue;
  }
  unpack(dir);
  const files = walk(dir);
  const find = (name) => files.find((f) => f.toLowerCase().endsWith(`/${name}`.toLowerCase()));
  const hi = find(`${car.model}_hi.yft`);
  const base = find(`${car.model}.yft`);
  const ytds = [find(`${car.model}.ytd`), find(`${car.model}+hi.ytd`)].filter(Boolean);
  if (!base) {
    console.log(`skip ${car.id}: no ${car.model}.yft`);
    continue;
  }
  execFileSync('dotnet', [CONV, 'car', `${RAW}/${car.id}.glb`, hi ?? base, ...ytds], { stdio: 'inherit' });
  const info = { ...car, handling: handling(files, car.model) };
  writeFileSync(`${OUT}/${car.id}.json`, JSON.stringify(info, null, 2));
}
