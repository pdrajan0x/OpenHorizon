// Converts the hero car mods listed below into raw .build/cars/<id>.glb files (then run
// scripts/optimize-models.mjs to make the game's public/mods/cars/<id>.glb and <id>_lod.glb), plus
// public/mods/cars/<id>.json with the mod's GTA handling values. Mods are fetched into .mods/ by
// scripts/fetch-mods.mjs (dlc.rpf archives are unpacked first with `gta5conv rpf`).
// Usage: node scripts/convert-cars.mjs [id ...]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CARS = [
  { id: 'lambo-huracan', mod: 'lambo-huracan-performante', model: 'vacca', name: 'Huracán Performante', make: 'Lamborghini' },
  // Muscle cars
  { id: 'muscle-charger-69', mod: 'muscle-charger-69', model: '69charger', name: 'Charger R/T 1969', make: 'Dodge' },
  { id: 'muscle-charger-dom-70', mod: 'muscle-charger-dom-70', model: 'rt70', name: "Charger R/T 1970 (Dom's)", make: 'Dodge' },
  { id: 'muscle-chevelle-70', mod: 'muscle-chevelle-70', model: 'chevelle1970', name: 'Chevelle SS 1970', make: 'Chevrolet' },
  { id: 'muscle-camaro-69', mod: 'muscle-camaro-69', model: 'camaro_ss', name: 'Camaro SS 1969', make: 'Chevrolet' },
  { id: 'muscle-challenger-70', mod: 'muscle-challenger-70', model: 'chall70', name: 'Challenger R/T Hemi 1970', make: 'Dodge' },
  { id: 'muscle-mustang-boss-69', mod: 'muscle-mustang-boss-69', model: 'boss429', name: 'Mustang Boss 429 1969', make: 'Ford' },
  { id: 'muscle-gto-judge-69', mod: 'muscle-gto-judge-69', model: 'judge', name: 'GTO Judge 1969', make: 'Pontiac' },
  // More supercars
  { id: 'koenigsegg-jesko', mod: 'hero-koenigsegg-jesko', model: 'jesko', name: 'Jesko Absolut', make: 'Koenigsegg', prefer: 'Legacy' },
  { id: 'mclaren-p1', mod: 'hero-mclaren-p1', model: 'p1', name: 'P1', make: 'McLaren' },
  { id: 'pagani-huayra-r', mod: 'hero-pagani-huayra-r', model: 'huayrar', name: 'Huayra R', make: 'Pagani' },
  { id: 'aston-valkyrie', mod: 'hero-aston-valkyrie', model: 'valkyrietp', name: 'Valkyrie', make: 'Aston Martin' },
  // Motorbikes
  { id: 'bike-ducati-v4', mod: 'bike-ducati-v4-speciale', model: 'v4sp', name: 'Panigale V4 Speciale', make: 'Ducati', bike: true },
  { id: 'bike-bmw-m1000rr', mod: 'bike-bmw-m1000rr', model: 'km1000rr', name: 'M 1000 RR', make: 'BMW', bike: true },
  { id: 'bike-kawasaki-h2r', mod: 'bike-kawasaki-h2r', model: 'nh2r', name: 'Ninja H2R', make: 'Kawasaki', bike: true },
  { id: 'bike-yamaha-r1m', mod: 'bike-yamaha-r1m', model: '20r1', name: 'YZF-R1M', make: 'Yamaha', bike: true },
  { id: 'bike-harley-street-glide', mod: 'bike-harley-street-glide', model: 'flhxs_streetglide_special18', name: 'Street Glide Special', make: 'Harley-Davidson', bike: true },
  { id: 'bike-harley-fat-boy', mod: 'bike-harley-fat-boy', model: 'hvrod', name: 'Fat Boy', make: 'Harley-Davidson', bike: true },
  // Everyday traffic
  { id: 'traffic-prius', mod: 'traffic-prius-taxi', model: 'priustaxi', name: 'Prius Taxi', make: 'Toyota' },
  { id: 'traffic-crownvic', mod: 'traffic-crownvic-taxi', model: 'taxi', name: 'Crown Victoria Taxi', make: 'Ford' },
  { id: 'traffic-camry', mod: 'traffic-camry', model: 'camry18', name: 'Camry', make: 'Toyota' },
  { id: 'traffic-passat', mod: 'traffic-passat', model: 'passat', name: 'Passat', make: 'Volkswagen' },
  { id: 'traffic-civic', mod: 'traffic-civic', model: 'premier', name: 'Civic', make: 'Honda' },
  { id: 'traffic-landcruiser', mod: 'traffic-landcruiser', model: 'lc200', name: 'Land Cruiser', make: 'Toyota' },
  { id: 'traffic-f150', mod: 'traffic-f150-raptor', model: 'f150', name: 'F-150 Raptor', make: 'Ford' },
  { id: 'traffic-sprinter', mod: 'traffic-sprinter', model: 'sprinter211', name: 'Sprinter', make: 'Mercedes-Benz' },
  { id: 'traffic-corolla', mod: 'traffic-corolla', model: 'stanier', name: 'Corolla', make: 'Toyota' },
  { id: 'traffic-bmw-330i', mod: 'traffic-bmw-330i', model: 'gxg20', name: '330i', make: 'BMW' }, // dlc.rpf only
  { id: 'traffic-mercedes-e300', mod: 'traffic-mercedes-e300', model: 'schafter2', name: 'E300', make: 'Mercedes-Benz' },
  { id: 'traffic-mercedes-c', mod: 'traffic-mercedes-c', model: 'schwarzer', name: 'C-Class', make: 'Mercedes-Benz' },
  { id: 'traffic-golf', mod: 'traffic-golf', model: 'golf75r', name: 'Golf R', make: 'Volkswagen' }, // dlc.rpf only
  { id: 'traffic-explorer', mod: 'traffic-explorer', model: 'explorer', name: 'Explorer', make: 'Ford' },
  { id: 'traffic-tahoe', mod: 'traffic-tahoe', model: 'rancherxl', name: 'Tahoe', make: 'Chevrolet' },
  { id: 'traffic-silverado', mod: 'traffic-silverado', model: 'silv', name: 'Silverado', make: 'Chevrolet' },
  { id: 'traffic-altima', mod: 'traffic-altima', model: '23altimavctsr', name: 'Altima', make: 'Nissan' }, // the loose replace is the 2013 car
  { id: 'traffic-sonata', mod: 'traffic-sonata', model: 'oracle2', name: 'Sonata', make: 'Hyundai' },
  { id: 'traffic-kia-k5', mod: 'traffic-kia-k5', model: 'stanier', name: 'K5', make: 'Kia' },
  { id: 'traffic-london-cab', mod: 'traffic-london-cab', model: 'dilettante', name: 'TX Taxi', make: 'LEVC' },
  { id: 'traffic-bus-man', mod: 'traffic-bus-man', model: 'bus', name: "Lion's City", make: 'MAN' },
  { id: 'traffic-transit', mod: 'traffic-transit', model: 'moonbeam2', name: 'Transit', make: 'Ford' },
  { id: 'traffic-crown-comfort-taxi', mod: 'traffic-crown-comfort-taxi', model: 'taxi', name: 'Crown Comfort Taxi', make: 'Toyota' },
  { id: 'traffic-kei-truck', mod: 'traffic-kei-truck', model: 'keitorac', name: 'Keitora', make: 'Kei truck' }, // dlc.rpf only
  { id: 'traffic-swift', mod: 'traffic-swift', model: 'swift2021', name: 'Swift', make: 'Suzuki' }, // dlc.rpf only
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

/**
 * Unpack the mod's dlc.rpf (the one under a folder named `prefer`, when a mod ships several: GTA V Enhanced
 * archives don't read), so loose files are available. Returns the folder unpacked into.
 */
function unpack(modDir, prefer) {
  const dest = join(modDir, prefer ? `rpf-${prefer}` : 'rpf');
  for (const f of walk(modDir)) {
    if (!f.endsWith('dlc.rpf') || /\/rpf(-[^/]+)?\//.test(f) || (prefer && !f.includes(`/${prefer}/`))) continue;
    if (!existsSync(dest)) execFileSync('dotnet', [CONV, 'rpf', f, dest], { stdio: 'inherit' });
  }
  return dest;
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
  const unpacked = unpack(dir, car.prefer);
  // With a preferred archive, only its files (and the loose ones beside it)
  const files = walk(dir).filter((f) => !car.prefer || f.startsWith(unpacked) || (f.includes(`/${car.prefer}/`) && !/\/rpf(-[^/]+)?\//.test(f)));
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
