#!/usr/bin/env node
/**
 * generate-city.mjs — build an isometric SimCity-style skyline out of a GitHub
 * contribution calendar.
 *
 * Every day of the year is one plot of land in the city grid:
 *   - a quiet day (0 contributions) becomes a park
 *   - the busier the day, the taller the building on that plot
 *   - the busiest day of the year becomes the landmark tower
 *
 * Emits a day view and a night view (neon, animated) into OUT_DIR.
 *
 * Usage: GITHUB_TOKEN=... node scripts/generate-city.mjs [username]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const USER = process.argv[2] || process.env.USERNAME || 'bitpackman';
const OUT_DIR = process.env.OUT_DIR || 'city';

// ---------------------------------------------------------------- geometry --
const TW = 26; // tile width in screen px
const TH = 13; // tile height in screen px
const S_SIDEWALK = 0.43; // half-extent of the paved plot, in tile units
const S_LOT = 0.4; // half-extent of a building footprint
const S_PARK = 0.37; // half-extent of a park lawn
const HMAX = 68; // tallest ordinary building
const SLAB = 14; // thickness of the ground slab
const HEADER = 64;
const FOOTER = 34;
const MARGIN = 26;

const r1 = (n) => Math.round(n * 10) / 10;

// ------------------------------------------------------------------ colour --
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) =>
    Math.max(0, Math.min(255, Math.round(v * f)))
  );
  return '#' + ch.map((v) => v.toString(16).padStart(2, '0')).join('');
}

const THEMES = {
  day: {
    id: 'day',
    sky: ['#bfe6ff', '#eaf7ff'],
    sun: '#fff2a8',
    sunGlow: '#ffe066',
    clouds: true,
    stars: false,
    asphalt: '#8f969e',
    sidewalk: '#c3c8cd',
    slabSide: '#6d737b',
    roadLine: '#f2f5f8',
    grass: '#7cc46b',
    tree: ['#3f8f4a', '#4e9c50', '#357c42'],
    dirt: ['#b5ae97', '#bdb59d', '#aba48f'],
    weed: ['#94a06c', '#8a9663', '#a3ac7d'],
    rubble: '#9a937f',
    deadTree: '#8b7f68',
    water: '#5fb6e0',
    window: ['#7fc4e8', '#9ad4f0'],
    windowLit: null,
    text: '#1d2c3a',
    textDim: '#4a5c6b',
    accent: '#e08a2b',
    walls: {
      1: ['#f6e3bd', '#efd9c4', '#f3e7d2'],
      2: ['#e3e9ee', '#e2e5d8', '#eae1e1'],
      3: ['#cbd8e4', '#d3dbd2', '#c9d2e0'],
      4: ['#aec6dc', '#b6c9d0', '#a8bcd4'],
    },
    roofs: { 1: '#c85c4c', 2: '#9fb0ba', 3: '#8397a8', 4: '#6b8299' },
    neon: null,
  },
  night: {
    id: 'night',
    sky: ['#060a18', '#1a2444'],
    sun: '#e8eefc',
    sunGlow: '#9fb6ff',
    clouds: false,
    stars: true,
    asphalt: '#161c2c',
    sidewalk: '#232b3f',
    slabSide: '#0b0f1c',
    roadLine: '#46527a',
    grass: '#162c22',
    tree: ['#153427', '#123024', '#1a4030'],
    dirt: ['#121723', '#141a27', '#101520'],
    weed: ['#1b2a20', '#18251d', '#1e3025'],
    rubble: '#1c2334',
    deadTree: '#262d3d',
    water: '#16324f',
    window: ['#ffd171', '#ffe6ab', '#ffbf47'],
    windowLit: '#6fe8ff',
    text: '#dbe9ff',
    textDim: '#7e93bd',
    accent: '#ffe400',
    walls: {
      1: ['#2a3350', '#26304a', '#2e3757'],
      2: ['#242d47', '#28324e', '#212a42'],
      3: ['#1f2841', '#232c48', '#1d2540'],
      4: ['#1a2239', '#1e2743', '#182036'],
    },
    roofs: { 1: '#151c2f', 2: '#141a2c', 3: '#121828', 4: '#101624' },
    neon: ['#ff4fd8', '#23e6ff', '#ffe400', '#7cff6b'],
  },
};

// ------------------------------------------------------------------- random --
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// -------------------------------------------------------------------- fetch --
async function fetchCalendar(login) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to read the contribution calendar');
  const query = `query($login:String!){
    user(login:$login){
      contributionsCollection{
        contributionCalendar{
          totalContributions
          weeks{ contributionDays{ date contributionCount weekday } }
        }
      }
    }
  }`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'city-of-commits',
    },
    body: JSON.stringify({ query, variables: { login } }),
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  const user = json.data && json.data.user;
  if (!user) throw new Error(`no such user: ${login}`);
  return user.contributionsCollection.contributionCalendar;
}

// --------------------------------------------------------------- city model --
function buildCity(calendar) {
  const weeks = calendar.weeks.map((w) => w.contributionDays);
  const cells = [];
  weeks.forEach((days, c) => {
    days.forEach((d) => {
      cells.push({ c, r: d.weekday, count: d.contributionCount, date: d.date });
    });
  });

  const nonzero = cells.filter((x) => x.count > 0).map((x) => x.count).sort((a, b) => a - b);
  const max = nonzero.length ? nonzero[nonzero.length - 1] : 1;
  const pctOf = (n) => {
    // share of active days at or below this count
    let lo = 0;
    let hi = nonzero.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (nonzero[mid] < n) lo = mid + 1;
      else hi = mid;
    }
    return nonzero.length > 1 ? lo / (nonzero.length - 1) : 1;
  };

  let landmark = null;
  for (const cell of cells) {
    if (cell.count === 0) {
      cell.level = 0;
      cell.h = 0;
      continue;
    }
    const p = pctOf(cell.count);
    cell.pct = p;
    cell.level = p < 0.25 ? 1 : p < 0.5 ? 2 : p < 0.75 ? 3 : 4;
    cell.h = 11 + p * 45 + (cell.count / max) * 12;
    if (!landmark || cell.count > landmark.count) landmark = cell;
  }
  if (landmark) {
    landmark.landmark = true;
    landmark.h = HMAX + 28;
    landmark.level = 4;
  }

  return {
    cells,
    weeks: weeks.length,
    max,
    landmark,
    total: calendar.totalContributions,
    from: cells[0] && cells[0].date,
    to: cells[cells.length - 1] && cells[cells.length - 1].date,
  };
}

// ------------------------------------------------------------------ drawing --
function renderSVG(city, theme) {
  const T = theme;
  const gx0 = -0.72;
  const gy0 = -0.72;
  const gx1 = city.weeks - 1 + 0.72;
  const gy1 = 6.72;

  const relX = (gx, gy) => (gx - gy) * (TW / 2);
  const relY = (gx, gy) => (gx + gy) * (TH / 2);

  const minX = relX(gx0, gy1);
  const maxX = relX(gx1, gy0);
  const topLift = Math.max(...city.cells.map((c) => c.h)) + 46; // landmark spire headroom
  const minY = relY(gx0, gy0) - topLift;
  const maxY = relY(gx1, gy1) + SLAB;

  const OX = MARGIN - minX;
  const OY = HEADER - minY;
  const W = Math.ceil(OX + maxX + MARGIN);
  const H = Math.ceil(OY + maxY + FOOTER);

  const P = (gx, gy, z = 0) => [OX + relX(gx, gy), OY + relY(gx, gy) - z];
  const poly = (pts, fill, extra = '') =>
    `<path d="M${pts.map((p) => `${r1(p[0])},${r1(p[1])}`).join('L')}Z" fill="${fill}"${extra}/>`;

  const ground = [];
  const objects = []; // { depth, svg }
  const push = (depth, svg) => objects.push({ depth, svg });

  // -- ground slab ---------------------------------------------------------
  const sN = P(gx0, gy0);
  const sE = P(gx1, gy0);
  const sS = P(gx1, gy1);
  const sW = P(gx0, gy1);
  ground.push(poly([sE, sS, [sS[0], sS[1] + SLAB], [sE[0], sE[1] + SLAB]], shade(T.slabSide, 1.15)));
  ground.push(poly([sW, sS, [sS[0], sS[1] + SLAB], [sW[0], sW[1] + SLAB]], T.slabSide));
  ground.push(poly([sN, sE, sS, sW], T.asphalt));

  // -- road markings -------------------------------------------------------
  const line = (a, b, color, width, dash) =>
    `<path d="M${r1(a[0])},${r1(a[1])}L${r1(b[0])},${r1(b[1])}" stroke="${color}" stroke-width="${width}" fill="none"${
      dash ? ` stroke-dasharray="${dash}"` : ''
    } opacity="0.55"/>`;
  for (let c = 0; c < city.weeks - 1; c++) {
    if ((c + 1) % 5 !== 0) continue;
    ground.push(line(P(c + 0.5, gy0), P(c + 0.5, gy1), T.roadLine, 1.2, '7 7'));
  }
  ground.push(line(P(gx0, 2.5), P(gx1, 2.5), T.roadLine, 1.2, '7 7'));
  ground.push(line(P(gx0, 5.5), P(gx1, 5.5), T.roadLine, 1.2, '7 7'));

  // -- plots ---------------------------------------------------------------
  const rhombus = (cx, cy, s, z = 0) => [
    P(cx - s, cy - s, z),
    P(cx + s, cy - s, z),
    P(cx + s, cy + s, z),
    P(cx - s, cy + s, z),
  ];

  const rngGlobal = mulberry32(hashStr(`${USER}:${city.to}`));
  const flickerBudget = { n: 0 };

  for (const cell of city.cells) {
    const { c, r } = cell;
    const rng = mulberry32(hashStr(`${cell.date}:${cell.count}:${T.id}`));

    if (cell.level === 0) {
      // ---- vacant lot -----------------------------------------------------
      // Nothing happened on this day, so nothing stands here. Bare earth, the
      // odd weed, and no reason for anyone to come by.
      ground.push(poly(rhombus(c, r, S_SIDEWALK), shade(T.sidewalk, 0.93)));
      ground.push(poly(rhombus(c, r, S_PARK), T.dirt[Math.floor(rng() * T.dirt.length)]));

      const roll = rng();
      if (roll < 0.1) {
        // a few tufts of weed pushing through
        let d = '';
        const n = 2 + Math.floor(rng() * 3);
        for (let i = 0; i < n; i++) {
          const p = P(c + (rng() - 0.5) * 0.5, r + (rng() - 0.5) * 0.5);
          const wh = 2.5 + rng() * 2.5;
          d += `M${r1(p[0])},${r1(p[1])}l${r1((rng() - 0.5) * 2)},${-r1(wh)}`;
        }
        push(
          c + r + 0.2,
          `<path d="${d}" stroke="${T.weed[Math.floor(rng() * T.weed.length)]}" stroke-width="1.1" fill="none"/>`
        );
      } else if (roll < 0.15) {
        // rubble left over from whatever used to be here
        let d = '';
        for (let i = 0; i < 3; i++) {
          const p = P(c + (rng() - 0.5) * 0.5, r + (rng() - 0.5) * 0.5);
          const s = 1 + rng() * 1.4;
          d += `M${r1(p[0] - s)},${r1(p[1])}l${r1(s)},${-r1(s * 0.5)}l${r1(s)},${r1(s * 0.5)}l${-r1(s)},${r1(
            s * 0.5
          )}Z`;
        }
        ground.push(`<path d="${d}" fill="${T.rubble}"/>`);
      } else if (roll < 0.19) {
        // one bare tree nobody planted on purpose
        const p = P(c + (rng() - 0.5) * 0.3, r + (rng() - 0.5) * 0.3);
        const th = 7 + rng() * 4;
        push(
          c + r + 0.2,
          `<path d="M${r1(p[0])},${r1(p[1])}v${-r1(th)}m0,${r1(th * 0.4)}l${-r1(th * 0.34)},${-r1(
            th * 0.34
          )}m${r1(th * 0.34)},${r1(th * 0.34)}l${r1(th * 0.3)},${-r1(th * 0.4)}" stroke="${
            T.deadTree
          }" stroke-width="1.2" fill="none"/>`
        );
      }
      continue;
    }

    ground.push(poly(rhombus(c, r, S_SIDEWALK), T.sidewalk));

    // ---- building ---------------------------------------------------------
    const h = cell.h;
    const lvl = cell.level;
    const palette = T.walls[lvl];
    const wall = palette[Math.floor(rng() * palette.length)];
    const top = shade(wall, 1.14);
    const right = shade(wall, 0.86);
    const left = shade(wall, 0.64);

    const s = S_LOT * (cell.landmark ? 1.18 : lvl === 1 ? 0.88 : 1);
    const N = P(c - s, r - s, h);
    const E = P(c + s, r - s, h);
    const So = P(c + s, r + s, h);
    const Wp = P(c - s, r + s, h);
    const E0 = P(c + s, r - s, 0);
    const S0 = P(c + s, r + s, 0);
    const W0 = P(c - s, r + s, 0);

    let svg = '';
    const pending = []; // windows that get an animated flicker, drawn last
    svg += poly([E, So, S0, E0], right);
    svg += poly([Wp, So, S0, W0], left);
    svg += poly([N, E, So, Wp], top);

    // windows, batched into one path per colour to keep the file small
    const cols = lvl >= 3 ? 3 : 2;
    const rows = Math.max(1, Math.min(5, Math.floor((h - 8) / 14)));
    const byColor = new Map();
    const addQuad = (color, quad) => {
      const d = `M${quad.map((p) => `${r1(p[0])},${r1(p[1])}`).join('L')}Z`;
      byColor.set(color, (byColor.get(color) || '') + d);
    };
    const faceQuad = (from, to, u0, u1, z0, z1) => {
      const gp = (u) => [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
      const [ax, ay] = gp(u0);
      const [bx, by] = gp(u1);
      return [P(ax, ay, z1), P(bx, by, z1), P(bx, by, z0), P(ax, ay, z0)];
    };
    const faces = [
      [[c + s, r - s], [c + s, r + s]], // right face, east -> south
      [[c - s, r + s], [c + s, r + s]], // left face, west -> south
    ];
    const step = (h - 9) / rows;
    for (let f = 0; f < faces.length; f++) {
      const [from, to] = faces[f];
      for (let i = 0; i < cols; i++) {
        const span = 0.74 / cols;
        const u0 = 0.13 + i * span + 0.022;
        const u1 = u0 + span - 0.044;
        for (let j = 0; j < rows; j++) {
          const z0 = 6 + j * step + 2.2;
          const z1 = z0 + step - 5.4;
          if (z1 <= z0) continue;
          let color;
          if (T.id === 'night') {
            const lit = rng();
            if (lit < 0.42) color = shade(wall, 0.5); // dark window
            else if (lit < 0.47 && T.windowLit) color = T.windowLit;
            else color = T.window[Math.floor(rng() * T.window.length)];
          } else {
            color = T.window[Math.floor(rng() * T.window.length)];
          }
          const quad = faceQuad(from, to, u0, u1, z0, z1);
          if (T.id === 'night' && color !== shade(wall, 0.5) && flickerBudget.n < 26 && rngGlobal() < 0.012) {
            flickerBudget.n++;
            pending.push({ quad, color, dur: r1(3 + rngGlobal() * 5) });
            continue;
          }
          addQuad(color, quad);
        }
      }
    }
    for (const [color, d] of byColor) svg += `<path d="${d}" fill="${color}"/>`;
    for (const fl of pending) {
      svg +=
        `<path d="M${fl.quad.map((p) => `${r1(p[0])},${r1(p[1])}`).join('L')}Z" fill="${fl.color}" opacity="0.25">` +
        `<animate attributeName="opacity" values="0.25;1;0.35;1;0.25" dur="${fl.dur}s" repeatCount="indefinite"/></path>`;
    }

    // rooftops
    if (lvl === 1) {
      // gable roof
      const rh = 6.5;
      const ridgeE = P(c + s, r, h + rh);
      const ridgeW = P(c - s, r, h + rh);
      svg += poly([Wp, So, ridgeE, ridgeW], T.roofs[1]);
      svg += poly([So, E, ridgeE], shade(T.roofs[1], 0.78));
    } else {
      // parapet + rooftop plant
      svg += poly(rhombus(c, r, s * 1.05, h + 1.6), shade(T.roofs[lvl], 1.05));
      const bx = s * 0.34;
      const bh = lvl >= 3 ? 7 : 5;
      const uN = P(c - bx, r - bx, h + bh + 1.6);
      const uE = P(c + bx, r - bx, h + bh + 1.6);
      const uS = P(c + bx, r + bx, h + bh + 1.6);
      const uW = P(c - bx, r + bx, h + bh + 1.6);
      const uE0 = P(c + bx, r - bx, h + 1.6);
      const uS0 = P(c + bx, r + bx, h + 1.6);
      const uW0 = P(c - bx, r + bx, h + 1.6);
      svg += poly([uE, uS, uS0, uE0], shade(T.roofs[lvl], 0.8));
      svg += poly([uW, uS, uS0, uW0], shade(T.roofs[lvl], 0.62));
      svg += poly([uN, uE, uS, uW], shade(T.roofs[lvl], 1.18));
    }

    // neon crown for the tall towers at night
    if (T.id === 'night' && lvl === 4) {
      const neon = T.neon[Math.floor(rng() * T.neon.length)];
      const band = faceQuad([c + s, r - s], [c + s, r + s], 0.1, 0.9, h - 7, h - 3.6);
      svg += poly(band, neon, ' filter="url(#glow)" opacity="0.95"');
      const band2 = faceQuad([c - s, r + s], [c + s, r + s], 0.1, 0.9, h - 7, h - 3.6);
      svg += poly(band2, neon, ' filter="url(#glow)" opacity="0.7"');
    }

    // landmark: spire + beacon
    if (cell.landmark) {
      const base = P(c, r, h + 2);
      const tip = P(c, r, h + 34);
      svg += `<path d="M${r1(base[0])},${r1(base[1])}L${r1(tip[0])},${r1(tip[1])}" stroke="${
        T.id === 'night' ? T.accent : '#8f9aa5'
      }" stroke-width="2"/>`;
      svg +=
        `<circle cx="${r1(tip[0])}" cy="${r1(tip[1])}" r="3.4" fill="${
          T.id === 'night' ? '#ff3b3b' : '#e8453c'
        }" filter="url(#glow)">` +
        `<animate attributeName="opacity" values="1;0.15;1" dur="1.8s" repeatCount="indefinite"/></circle>`;
    }

    push(c + r, svg);
  }

  // -- street furniture ----------------------------------------------------
  // Traffic and street lighting only exist where there is something to drive
  // to, so stretches with no contributions stay dark and empty.
  const heightAt = new Map(city.cells.map((x) => [`${x.c},${x.r}`, x.h]));
  const activityAt = (gx, gy) => {
    const c0 = Math.round(gx);
    const r0 = Math.round(gy);
    let sum = 0;
    for (let dc = -2; dc <= 2; dc++) {
      for (let dr = -1; dr <= 1; dr++) sum += heightAt.get(`${c0 + dc},${r0 + dr}`) || 0;
    }
    return sum;
  };
  const LIVELY = 50;

  const carColors =
    T.id === 'night'
      ? ['#ff5a5a', '#ffd166', '#69d2ff', '#ffffff']
      : ['#e05252', '#3f7fd0', '#f0c04a', '#f2f2f2', '#4fb372'];
  for (let c = 0; c < city.weeks - 1; c++) {
    for (let r = 0; r < 7; r++) {
      const rng = mulberry32(hashStr(`car:${c}:${r}:${T.id}`));
      const act = activityAt(c + 0.5, r);
      if (act < LIVELY) continue;
      if (rng() > 0.05 + Math.min(act / 900, 0.2)) continue;
      const gx = c + 0.5;
      const gy = r + (rng() - 0.5) * 0.5;
      const sx = 0.07;
      const sy = 0.2;
      const ch = 5;
      const col = carColors[Math.floor(rng() * carColors.length)];
      const cN = P(gx - sx, gy - sy, ch);
      const cE = P(gx + sx, gy - sy, ch);
      const cS = P(gx + sx, gy + sy, ch);
      const cW = P(gx - sx, gy + sy, ch);
      const cE0 = P(gx + sx, gy - sy, 0);
      const cS0 = P(gx + sx, gy + sy, 0);
      const cW0 = P(gx - sx, gy + sy, 0);
      let svg = poly([cE, cS, cS0, cE0], shade(col, 0.82));
      svg += poly([cW, cS, cS0, cW0], shade(col, 0.62));
      svg += poly([cN, cE, cS, cW], col);
      if (T.id === 'night') {
        const hp = P(gx, gy + sy, 3);
        svg += `<circle cx="${r1(hp[0])}" cy="${r1(hp[1])}" r="2.2" fill="#fff6c9" opacity="0.85" filter="url(#glow)"/>`;
      }
      push(gx + gy, svg);
    }
  }

  // street lamps on the main avenues
  for (let c = 4; c < city.weeks - 1; c += 5) {
    for (const r of [2.5, 5.5]) {
      const gx = c + 0.5;
      if (activityAt(gx, r) < LIVELY) continue;
      const p0 = P(gx, r, 0);
      const p1 = P(gx, r, 17);
      let svg = `<path d="M${r1(p0[0])},${r1(p0[1])}L${r1(p1[0])},${r1(p1[1])}" stroke="${
        T.id === 'night' ? '#39435f' : '#5f666e'
      }" stroke-width="1.6"/>`;
      svg += `<circle cx="${r1(p1[0])}" cy="${r1(p1[1])}" r="${T.id === 'night' ? 3.2 : 2.2}" fill="${
        T.id === 'night' ? '#ffd98a' : '#cfd5da'
      }"${T.id === 'night' ? ' filter="url(#glow)"' : ''}/>`;
      if (T.id === 'night') {
        const g = P(gx, r, 0);
        ground.push(
          `<ellipse cx="${r1(g[0])}" cy="${r1(g[1])}" rx="16" ry="8" fill="#ffd98a" opacity="0.11"/>`
        );
      }
      push(gx + r, svg);
    }
  }

  objects.sort((a, b) => a.depth - b.depth);

  // -- sky -----------------------------------------------------------------
  let sky = '';
  if (T.stars) {
    const rng = mulberry32(1337);
    let d = '';
    for (let i = 0; i < 130; i++) {
      const x = r1(rng() * W);
      const y = r1(rng() * (OY * 0.75));
      const s = r1(0.5 + rng() * 1.1);
      d += `M${x},${y}h${s}v${s}h${-s}Z`;
    }
    sky += `<path d="${d}" fill="#ffffff" opacity="0.75"/>`;
    sky += `<circle cx="${W - 104}" cy="104" r="24" fill="${T.sun}" opacity="0.95"/>`;
    sky += `<circle cx="${W - 94}" cy="96" r="24" fill="${T.sky[0]}"/>`;
  } else {
    sky += `<circle cx="${W - 104}" cy="104" r="46" fill="${T.sunGlow}" opacity="0.32"/>`;
    sky += `<circle cx="${W - 104}" cy="104" r="24" fill="${T.sun}"/>`;
  }
  if (T.clouds) {
    const rng = mulberry32(99);
    for (let i = 0; i < 5; i++) {
      const x = 60 + rng() * (W - 200);
      const y = 40 + rng() * (OY * 0.4);
      const sc = 0.7 + rng() * 0.8;
      sky +=
        `<g opacity="0.7" transform="translate(${r1(x)},${r1(y)}) scale(${r1(sc)})">` +
        `<ellipse cx="0" cy="0" rx="26" ry="11" fill="#ffffff"/>` +
        `<ellipse cx="18" cy="4" rx="20" ry="9" fill="#ffffff"/>` +
        `<ellipse cx="-16" cy="4" rx="17" ry="8" fill="#ffffff"/></g>`;
    }
  }

  // -- copy ----------------------------------------------------------------
  const mono = 'ui-monospace,SFMono-Regular,Menlo,Consolas,monospace';
  const fmt = (d) => (d || '').replace(/-/g, '.');
  const label = city.landmark
    ? `LANDMARK ${fmt(city.landmark.date)} — ${city.landmark.count} contributions`
    : '';
  const text =
    `<g font-family="${mono}">` +
    `<text x="${MARGIN}" y="36" font-size="23" font-weight="700" fill="${T.text}" letter-spacing="2.5">CITY OF COMMITS</text>` +
    `<text x="${MARGIN}" y="54" font-size="11.5" fill="${T.textDim}" letter-spacing="1">@${USER} — ${city.total} contributions zoned into ${
      city.cells.length
    } city blocks</text>` +
    `<text x="${W - MARGIN}" y="36" font-size="12" fill="${T.accent}" text-anchor="end" letter-spacing="1.5">${
      T.id === 'night' ? 'NIGHT SHIFT' : 'DAY SHIFT'
    }</text>` +
    `<text x="${W - MARGIN}" y="53" font-size="10.5" fill="${T.textDim}" text-anchor="end">${fmt(city.from)} → ${fmt(
      city.to
    )}</text>` +
    `<text x="${MARGIN}" y="${H - 13}" font-size="10.5" fill="${T.textDim}">${label}</text>` +
    `<text x="${W - MARGIN}" y="${H - 13}" font-size="10.5" fill="${
      T.textDim
    }" text-anchor="end">vacant lot = a day I shipped nothing · taller tower = busier day</text>` +
    `</g>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="An isometric city generated from the GitHub contributions of ${USER}">
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="${T.sky[0]}"/><stop offset="1" stop-color="${T.sky[1]}"/>
</linearGradient>
<filter id="glow" x="-120%" y="-120%" width="340%" height="340%">
<feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
</filter>
</defs>
<rect width="${W}" height="${H}" fill="url(#sky)"/>
${sky}
<g shape-rendering="geometricPrecision">
${ground.join('\n')}
${objects.map((o) => o.svg).join('\n')}
</g>
${text}
</svg>
`;
}

// --------------------------------------------------------------------- main --
const calendar = await fetchCalendar(USER);
const city = buildCity(calendar);
await mkdir(OUT_DIR, { recursive: true });
for (const theme of Object.values(THEMES)) {
  const svg = renderSVG(city, theme);
  const file = join(OUT_DIR, `city-${theme.id}.svg`);
  await writeFile(file, svg);
  console.log(`${file}  ${(svg.length / 1024).toFixed(0)}KB`);
}
console.log(
  `${USER}: ${city.total} contributions, ${city.cells.filter((c) => c.count > 0).length} built plots, landmark ${
    city.landmark && city.landmark.date
  } (${city.landmark && city.landmark.count})`
);
