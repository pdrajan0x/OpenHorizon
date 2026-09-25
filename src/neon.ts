// Canvas-drawn neon signage. All names are invented.
import * as THREE from 'three';

export const SIGN_TEXTS = [
  'RAMEN 24H', 'NEON LOTUS', 'KAIJU BAR', 'OXIDE', 'HOTEL NOVA', 'ARCADE', 'SYNTH', 'VOLT',
  'ZERO CAFE', 'DRIFT CLUB', 'MIDNIGHT', 'NOODLES', 'ラーメン', '夜市', '電気', 'カラオケ', 'HOLO', 'PHARMACY',
];
export const NEON_COLORS = ['#ff2bd6', '#00e5ff', '#ffd23a', '#7a5cff', '#ff4d4d', '#39ff88', '#ff8a00'];
const FONT = '"Noto Sans CJK JP", "Noto Sans CJK TC", "Noto Sans", system-ui, sans-serif';

/** A sign panel: dark backing, neon border tube, glowing lettering. Vertical signs stack their characters. */
export function signTexture(text: string, color: string, vertical: boolean): THREE.CanvasTexture {
  const w = vertical ? 128 : 512;
  const h = vertical ? 512 : 128;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  g.fillStyle = 'rgba(8,4,16,0.92)';
  g.fillRect(0, 0, w, h);
  g.strokeStyle = color;
  g.lineWidth = 5;
  g.shadowColor = color;
  g.shadowBlur = 14;
  g.strokeRect(8, 8, w - 16, h - 16);

  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  if (vertical) {
    const chars = [...text.replace(/ /g, '')];
    const step = (h - 40) / chars.length;
    g.font = `bold ${Math.min(84, step * 0.85)}px ${FONT}`;
    chars.forEach((ch, i) => {
      g.shadowBlur = 18;
      g.fillStyle = color;
      g.fillText(ch, w / 2, 20 + step * (i + 0.5));
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(ch, w / 2, 20 + step * (i + 0.5));
    });
  } else {
    let size = 76;
    g.font = `bold ${size}px ${FONT}`;
    while (g.measureText(text).width > w - 60 && size > 20) g.font = `bold ${(size -= 4)}px ${FONT}`;
    g.shadowBlur = 20;
    g.fillStyle = color;
    g.fillText(text, w / 2, h / 2 + 4);
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(255,255,255,0.85)';
    g.fillText(text, w / 2, h / 2 + 4);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/**
 * Building facade tile: 16 columns × 8 floors of tall glass panes with mullions. Lit windows cluster
 * by floor, the way offices and apartments do, in warm, cool and occasional neon tints.
 */
export function facadeTextures(): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const size = 512;
  const cols = 16;
  const rows = 8;
  const cw = size / cols;
  const ch = size / rows;
  const make = () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    return canvas;
  };
  const mapCanvas = make();
  const glowCanvas = make();
  const m = mapCanvas.getContext('2d')!;
  const e = glowCanvas.getContext('2d')!;
  m.fillStyle = '#2b2e35';
  m.fillRect(0, 0, size, size);
  e.fillStyle = '#000';
  e.fillRect(0, 0, size, size);
  const tints = ['#ffb070', '#ffc98a', '#ffc98a', '#8fd0ff', '#b5e0ff', '#ff4fc8', '#3dffd0'];
  for (let y = 0; y < rows; y++) {
    const floorLit = Math.random() < 0.45 ? 0.2 + Math.random() * 0.6 : 0.04;
    const floorTint = tints[Math.floor(Math.random() * tints.length)];
    for (let x = 0; x < cols; x++) {
      // Cell (0,0)'s corner stays bare facade: roofs sample it
      const px = x * cw + 3;
      const py = y * ch + 7;
      const pw = cw - 6;
      const ph = ch - 14;
      const glass = m.createLinearGradient(0, py, 0, py + ph);
      glass.addColorStop(0, '#16202b');
      glass.addColorStop(1, '#0a0e14');
      m.fillStyle = glass;
      m.fillRect(px, py, pw, ph);
      if (Math.random() < floorLit) {
        const tint = Math.random() < 0.8 ? floorTint : tints[Math.floor(Math.random() * tints.length)];
        const blinds = Math.random() < 0.35 ? ph * (0.2 + Math.random() * 0.5) : 0;
        e.globalAlpha = 0.35 + Math.random() * 0.45;
        e.fillStyle = tint;
        e.fillRect(px, py + blinds, pw, ph - blinds);
        m.globalAlpha = 0.3;
        m.fillStyle = tint;
        m.fillRect(px, py + blinds, pw, ph - blinds);
        m.globalAlpha = e.globalAlpha = 1;
      }
      // Mullion down the middle of each pane
      m.fillStyle = '#2b2e35';
      m.fillRect(px + pw / 2 - 0.5, py, 1, ph);
      e.fillStyle = '#000';
      e.fillRect(px + pw / 2 - 0.5, py, 1, ph);
    }
  }
  const tex = (canvas: HTMLCanvasElement) => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  return { map: tex(mapCanvas), emissive: tex(glowCanvas) };
}

/** Grayscale ad-screen art; the material color tints it and cycles the hue. */
export function adTexture(text: string): THREE.CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, 'rgba(90,90,90,0.9)');
  grad.addColorStop(1, 'rgba(25,25,25,0.9)');
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  let size = 120;
  g.font = `900 ${size}px ${FONT}`;
  while (g.measureText(text).width > w - 50 && size > 24) g.font = `900 ${(size -= 6)}px ${FONT}`;
  g.shadowColor = '#fff';
  g.shadowBlur = 24;
  g.fillText(text, w / 2, h / 2);
  g.shadowBlur = 0;
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let y = 0; y < h; y += 4) g.fillRect(0, y, w, 1.5); // scanlines
  g.strokeStyle = '#fff';
  g.lineWidth = 4;
  g.strokeRect(4, 4, w - 8, h - 8);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Soft round falloff, for light pools and blob shadows. */
export function radialTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.4)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}
