import * as THREE from 'three';

/**
 * Procedural canvas textures. Generated once at boot — no external assets,
 * so the game loads instantly and stays self-contained.
 */

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  return { c, ctx };
}

function finish(c: HTMLCanvasElement, opts: { srgb?: boolean; repeat?: boolean; aniso?: number } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat !== false) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = opts.aniso ?? 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/** Deterministic PRNG so textures look identical every run. */
function mulberry(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cache = new Map<string, THREE.Texture>();
function cached(key: string, make: () => THREE.Texture) {
  let t = cache.get(key);
  if (!t) {
    t = make();
    cache.set(key, t);
  }
  return t;
}

/** Tar & gravel roof membrane. */
export function roofTexture() {
  return cached('roof', () => {
    const { c, ctx } = canvas(512, 512);
    const r = mulberry(7);
    ctx.fillStyle = '#5d5a60';
    ctx.fillRect(0, 0, 512, 512);
    // large stains
    for (let i = 0; i < 26; i++) {
      const x = r() * 512;
      const y = r() * 512;
      const rad = 30 + r() * 90;
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
      const dark = r() > 0.5;
      g.addColorStop(0, dark ? 'rgba(30,28,34,0.25)' : 'rgba(140,130,125,0.18)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    // gravel
    for (let i = 0; i < 26000; i++) {
      const x = r() * 512;
      const y = r() * 512;
      const v = 60 + r() * 90;
      ctx.fillStyle = `rgb(${v + 6},${v},${v - 2})`;
      const s = r() < 0.9 ? 1 : 2;
      ctx.fillRect(x, y, s, s);
    }
    // membrane seams
    ctx.strokeStyle = 'rgba(25,24,28,0.55)';
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(0, i * 128 + 2);
      ctx.lineTo(512, i * 128 + 2);
      ctx.stroke();
    }
    return finish(c);
  });
}

export function concreteTexture() {
  return cached('concrete', () => {
    const { c, ctx } = canvas(256, 256);
    const r = mulberry(11);
    ctx.fillStyle = '#a7a2a0';
    ctx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 9000; i++) {
      const v = 130 + r() * 70;
      ctx.fillStyle = `rgba(${v},${v - 4},${v - 8},0.35)`;
      ctx.fillRect(r() * 256, r() * 256, 1 + r() * 2, 1 + r() * 2);
    }
    for (let i = 0; i < 18; i++) {
      ctx.fillStyle = 'rgba(60,55,58,0.07)';
      ctx.beginPath();
      ctx.arc(r() * 256, r() * 256, 10 + r() * 40, 0, Math.PI * 2);
      ctx.fill();
    }
    // streaks of dirt
    for (let i = 0; i < 30; i++) {
      const x = r() * 256;
      const g = ctx.createLinearGradient(x, 0, x, 256);
      g.addColorStop(0, 'rgba(40,36,40,0.12)');
      g.addColorStop(1, 'rgba(40,36,40,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, 0, 1 + r() * 3, 120 + r() * 136);
    }
    return finish(c);
  });
}

export function brickTexture() {
  return cached('brick', () => {
    const { c, ctx } = canvas(256, 256);
    const r = mulberry(3);
    ctx.fillStyle = '#d8c8b8';
    ctx.fillRect(0, 0, 256, 256);
    const bh = 256 / 8;
    const bw = 256 / 4;
    for (let row = 0; row < 8; row++) {
      for (let col = -1; col < 5; col++) {
        const x = col * bw + (row % 2 ? bw / 2 : 0);
        const y = row * bh;
        const t = r();
        const R = 150 + t * 40;
        const G = 62 + t * 22;
        const B = 46 + t * 14;
        ctx.fillStyle = `rgb(${R},${G},${B})`;
        ctx.fillRect(x + 3, y + 3, bw - 6, bh - 6);
        for (let k = 0; k < 40; k++) {
          ctx.fillStyle = `rgba(0,0,0,${r() * 0.12})`;
          ctx.fillRect(x + 3 + r() * (bw - 8), y + 3 + r() * (bh - 8), 2, 2);
        }
      }
    }
    return finish(c);
  });
}

export function woodTexture() {
  return cached('wood', () => {
    const { c, ctx } = canvas(256, 256);
    const r = mulberry(21);
    const planks = 4;
    for (let p = 0; p < planks; p++) {
      const y = (p * 256) / planks;
      const t = r();
      ctx.fillStyle = `rgb(${176 + t * 30},${120 + t * 22},${70 + t * 14})`;
      ctx.fillRect(0, y, 256, 256 / planks);
      for (let i = 0; i < 26; i++) {
        ctx.strokeStyle = `rgba(90,50,20,${0.08 + r() * 0.12})`;
        ctx.lineWidth = 1 + r() * 1.5;
        ctx.beginPath();
        const yy = y + r() * (256 / planks);
        ctx.moveTo(0, yy);
        ctx.bezierCurveTo(80, yy + (r() - 0.5) * 8, 170, yy + (r() - 0.5) * 8, 256, yy);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(50,25,10,0.6)';
      ctx.fillRect(0, y, 256, 3);
    }
    return finish(c);
  });
}

/** Yellow/black hazard stripes. */
export function hazardTexture() {
  return cached('hazard', () => {
    const { c, ctx } = canvas(128, 128);
    ctx.fillStyle = '#f5c400';
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = '#1a1a1a';
    for (let i = -2; i < 4; i++) {
      ctx.beginPath();
      ctx.moveTo(i * 64, 0);
      ctx.lineTo(i * 64 + 32, 0);
      ctx.lineTo(i * 64 + 32 + 128, 128);
      ctx.lineTo(i * 64 + 128, 128);
      ctx.closePath();
      ctx.fill();
    }
    return finish(c);
  });
}

/** Helipad / painted floor markings (alpha). */
export function helipadTexture() {
  return cached('helipad', () => {
    const { c, ctx } = canvas(512, 512);
    ctx.clearRect(0, 0, 512, 512);
    ctx.strokeStyle = 'rgba(245,240,230,0.85)';
    ctx.lineWidth = 18;
    ctx.beginPath();
    ctx.arc(256, 256, 220, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([30, 22]);
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(256, 256, 188, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(245,240,230,0.85)';
    ctx.font = '900 300px Impact, "Arial Black", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('B', 256, 270);
    // worn paint
    const r = mulberry(5);
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 1800; i++) {
      ctx.fillStyle = `rgba(0,0,0,${r() * 0.45})`;
      ctx.beginPath();
      ctx.arc(r() * 512, r() * 512, 0.8 + r() * 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    return finish(c, { repeat: false });
  });
}

/** Cardboard with tape. */
export function cardboardTexture() {
  return cached('cardboard', () => {
    const { c, ctx } = canvas(128, 128);
    const r = mulberry(9);
    ctx.fillStyle = '#c49a62';
    ctx.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 1500; i++) {
      ctx.fillStyle = `rgba(90,60,30,${r() * 0.15})`;
      ctx.fillRect(r() * 128, r() * 128, 1, 3);
    }
    ctx.fillStyle = 'rgba(220,200,150,0.85)';
    ctx.fillRect(54, 0, 20, 128);
    ctx.fillStyle = 'rgba(60,40,20,0.8)';
    ctx.font = 'bold 18px sans-serif';
    ctx.fillText('FRAGILE', 18, 100);
    return finish(c, { repeat: false });
  });
}

/** Crate planks with dark gaps & nails. */
export function crateTexture() {
  return cached('crate', () => {
    const { c, ctx } = canvas(256, 256);
    const wood = woodTexture().image as HTMLCanvasElement;
    ctx.drawImage(wood, 0, 0);
    ctx.strokeStyle = '#4a2c14';
    ctx.lineWidth = 14;
    ctx.strokeRect(7, 7, 242, 242);
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(10, 10);
    ctx.lineTo(246, 246);
    ctx.stroke();
    ctx.fillStyle = '#222';
    for (const [x, y] of [[14, 14], [242, 14], [14, 242], [242, 242]]) {
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    return finish(c, { repeat: false });
  });
}

/** Soft round particle sprite (white, alpha). */
export function softDotTexture() {
  return cached('softdot', () => {
    const { c, ctx } = canvas(64, 64);
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.4, 'rgba(255,255,255,0.6)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return finish(c, { repeat: false, srgb: false });
  });
}

/**
 * Sprite atlas (4x2 cells, 128px each):
 * 0 soft dot, 1 star burst, 2 smoke puff, 3 ring, 4 cartoon star (yellow), 5 spark streak, 6 sweat drop, 7 swirl
 */
export function spriteAtlas() {
  return cached('atlas', () => {
    const S = 128;
    const { c, ctx } = canvas(S * 4, S * 2);
    const cell = (i: number) => [(i % 4) * S, Math.floor(i / 4) * S] as const;
    const r = mulberry(31);
    // 0 soft dot
    {
      const [x, y] = cell(0);
      const g = ctx.createRadialGradient(x + 64, y + 64, 0, x + 64, y + 64, 62);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.35, 'rgba(255,255,255,0.7)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, S, S);
    }
    // 1 impact burst (spiky)
    {
      const [x, y] = cell(1);
      ctx.save();
      ctx.translate(x + 64, y + 64);
      ctx.fillStyle = 'rgba(255,255,255,1)';
      ctx.beginPath();
      const spikes = 12;
      for (let i = 0; i < spikes * 2; i++) {
        const a = (i / (spikes * 2)) * Math.PI * 2;
        const rad = i % 2 === 0 ? 60 - r() * 10 : 22 + r() * 6;
        ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    // 2 smoke puff
    {
      const [x, y] = cell(2);
      for (let i = 0; i < 9; i++) {
        const px = x + 64 + (r() - 0.5) * 50;
        const py = y + 64 + (r() - 0.5) * 50;
        const rad = 22 + r() * 22;
        const g = ctx.createRadialGradient(px, py, 0, px, py, rad);
        g.addColorStop(0, 'rgba(255,255,255,0.55)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(x, y, S, S);
      }
    }
    // 3 ring
    {
      const [x, y] = cell(3);
      ctx.strokeStyle = 'rgba(255,255,255,1)';
      ctx.lineWidth = 9;
      ctx.beginPath();
      ctx.arc(x + 64, y + 64, 52, 0, Math.PI * 2);
      ctx.stroke();
    }
    // 4 cartoon star
    {
      const [x, y] = cell(4);
      ctx.save();
      ctx.translate(x + 64, y + 66);
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i / 10) * Math.PI * 2;
        const rad = i % 2 === 0 ? 56 : 24;
        ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
      }
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.restore();
    }
    // 5 spark streak
    {
      const [x, y] = cell(5);
      const g = ctx.createLinearGradient(x, y + 64, x + S, y + 64);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.7, 'rgba(255,255,255,1)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y + 58, S, 12);
    }
    // 6 drop
    {
      const [x, y] = cell(6);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(x + 64, y + 14);
      ctx.bezierCurveTo(x + 100, y + 64, x + 100, y + 110, x + 64, y + 112);
      ctx.bezierCurveTo(x + 28, y + 110, x + 28, y + 64, x + 64, y + 14);
      ctx.fill();
    }
    // 7 swirl
    {
      const [x, y] = cell(7);
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 7;
      ctx.beginPath();
      for (let i = 0; i < 120; i++) {
        const a = i * 0.16;
        const rad = 4 + i * 0.45;
        ctx.lineTo(x + 64 + Math.cos(a) * rad, y + 64 + Math.sin(a) * rad);
      }
      ctx.stroke();
    }
    return finish(c, { repeat: false, srgb: false });
  });
}

/** Stylized blood splat for floor decals (white alpha mask, tinted in shader). */
export function splatAtlas() {
  return cached('splat', () => {
    const S = 128;
    const { c, ctx } = canvas(S * 4, S);
    const r = mulberry(77);
    for (let k = 0; k < 4; k++) {
      const ox = k * S + 64;
      const oy = 64;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      const n = 18;
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const rad = 26 + r() * 16;
        ctx.lineTo(ox + Math.cos(a) * rad, oy + Math.sin(a) * rad);
      }
      ctx.fill();
      for (let i = 0; i < 9; i++) {
        const a = r() * Math.PI * 2;
        const d = 36 + r() * 22;
        const rad = 3 + r() * 8;
        ctx.beginPath();
        ctx.arc(ox + Math.cos(a) * d, oy + Math.sin(a) * d, rad, 0, Math.PI * 2);
        ctx.fill();
        // streak
        ctx.beginPath();
        ctx.moveTo(ox + Math.cos(a) * 20, oy + Math.sin(a) * 20);
        ctx.lineTo(ox + Math.cos(a) * d, oy + Math.sin(a) * d);
        ctx.lineWidth = rad * 0.9;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
    }
    return finish(c, { repeat: false, srgb: false });
  });
}

/** Comic onomatopoeia words rendered once into an atlas (2x4 grid). */
export const COMIC_WORDS = ['PAF!', 'BIM!', 'BAM!', 'VLAN!', 'SBAFF!', 'BOING!', 'CRAC!', 'POW!'];
export function comicAtlas() {
  return cached('comic', () => {
    const W = 256;
    const H = 128;
    const { c, ctx } = canvas(W * 2, H * 4);
    const palette = ['#ffe14d', '#ff5a5a', '#66e0ff', '#ffffff', '#ffb02e', '#ff7ae8', '#b8ff5c', '#ffd23f'];
    COMIC_WORDS.forEach((word, i) => {
      const x = (i % 2) * W + W / 2;
      const y = Math.floor(i / 2) * H + H / 2;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(((i % 3) - 1) * 0.08);
      ctx.font = '900 76px "Luckiest Guy", Impact, "Arial Black", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      ctx.lineWidth = 16;
      ctx.strokeStyle = '#111';
      ctx.strokeText(word, 0, 4);
      ctx.fillStyle = palette[i];
      ctx.fillText(word, 0, 0);
      ctx.restore();
    });
    return finish(c, { repeat: false });
  });
}

/** Text on a transparent canvas (neon signs, speech bubbles...). */
export function textTexture(text: string, opts: { font?: string; color?: string; w?: number; h?: number; stroke?: string; glow?: string } = {}) {
  const w = opts.w ?? 512;
  const h = opts.h ?? 128;
  const { c, ctx } = canvas(w, h);
  ctx.font = opts.font ?? `900 ${Math.floor(h * 0.7)}px "Luckiest Guy", Impact, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opts.glow) {
    ctx.shadowColor = opts.glow;
    ctx.shadowBlur = h * 0.15;
  }
  if (opts.stroke) {
    ctx.lineWidth = h * 0.1;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = opts.stroke;
    ctx.strokeText(text, w / 2, h / 2);
  }
  ctx.fillStyle = opts.color ?? '#fff';
  ctx.fillText(text, w / 2, h / 2);
  return finish(c, { repeat: false });
}

/** Speech bubble with text, used for AI taunts. */
export function speechBubbleTexture(text: string) {
  const w = 512;
  const h = 192;
  const { c, ctx } = canvas(w, h);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 8;
  const rr = 42;
  ctx.beginPath();
  ctx.moveTo(rr + 8, 8);
  ctx.arcTo(w - 8, 8, w - 8, h - 50, rr);
  ctx.arcTo(w - 8, h - 50, 8, h - 50, rr);
  ctx.lineTo(w / 2 + 30, h - 50);
  ctx.lineTo(w / 2 - 10, h - 6);
  ctx.lineTo(w / 2 - 10, h - 50);
  ctx.arcTo(8, h - 50, 8, 8, rr);
  ctx.arcTo(8, 8, w - 8, 8, rr);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#111';
  let size = 58;
  ctx.font = `900 ${size}px "Luckiest Guy", Impact, sans-serif`;
  while (ctx.measureText(text).width > w - 60 && size > 20) {
    size -= 4;
    ctx.font = `900 ${size}px "Luckiest Guy", Impact, sans-serif`;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, (h - 50) / 2 + 6);
  return finish(c, { repeat: false });
}
