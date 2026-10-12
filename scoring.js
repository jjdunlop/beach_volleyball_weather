// Shared settings, scoring and data parsing for the page (index.html) and the alert script (scripts/alert.js).
// Plain script: in the browser its top-level names are globals; in Node it is required as a module.

// ---------- Settings: tune these after a few weekends ----------
const LAT = -37.8455, LON = 144.9475;          // South Melbourne Beach
const TZ = "Australia/Melbourne";
const BEACH_FACES = 225;                        // beach faces SW; wind FROM here is onshore
const BLOCKS = [                                // dow: 5 = Fri, 6 = Sat, 0 = Sun. Hours are local, end exclusive.
  { name: "Fri night",  dow: 5, start: 17, end: 20 },
  { name: "Sat midday", dow: 6, start: 11, end: 14 },
  { name: "Sat arvo",   dow: 6, start: 14, end: 18 },
  { name: "Sun midday", dow: 0, start: 11, end: 14 },
  { name: "Sun arvo",   dow: 0, start: 14, end: 18 },
];
const TIERS = [                                 // first match wins
  { min: 8.5, key: "epic",   label: "Epic" },
  { min: 7,   key: "go",     label: "Go" },
  { min: 5,   key: "decent", label: "Decent" },
  { min: 3,   key: "meh",    label: "Meh" },
  { min: 0,   key: "skip",   label: "Skip" },
];
const tierOf = r => TIERS.find(t => r >= t.min);

// ---------- Scoring ----------
function dirFactor(fromDeg) {
  // 1.15 dead onshore (SW), 0.75 dead offshore (NE); N ≈ 0.81, S ≈ 1.09
  return 0.95 + 0.2 * Math.cos(((fromDeg - BEACH_FACES) * Math.PI) / 180);
}
function curve(x, pts) {                        // linear interpolation through [x, y] points, flat beyond the ends
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) {
    const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
  }
  return pts[pts.length - 1][1];
}
// 0–10 "worth going" rating for one hour. Calm wind drives it; temperature and rain scale it down.
function hourScore(h) {
  const eff = h.wind * dirFactor(h.dir);                                // km/h, adjusted for shelter
  const windR = curve(eff, [[5, 10], [12, 7.5], [25, 2], [32, 0]]);     // glassy = 10, still rewarding calm below 12
  const gust = h.gust ?? h.wind * 1.5;
  const gustPen = Math.max(0, gust - 25) * 0.15;                        // 40 km/h gusts → -2.25
  const tempM = curve(h.temp, [[12, 0.3], [20, 1], [32, 1], [35, 0.75], [40, 0.3]]);  // 20–32°C no penalty
  const rainM = h.rain >= 1 ? 0.2 : h.rain >= 0.2 ? 0.5 : 1;
  return Math.max(0, Math.min(10, (windR - gustPen) * tempM * rainM));
}

// ---------- Helpers ----------
const dowOf = d => new Date(d + "T12:00:00Z").getUTCDay();
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const pctile = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * p, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const COMPASS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
const compass = d => COMPASS[Math.round(((d % 360) + 360) % 360 / 22.5) % 16];
function circMean(degs) {
  let x = 0, y = 0; for (const d of degs) { x += Math.cos(d * Math.PI / 180); y += Math.sin(d * Math.PI / 180); }
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
function nowMelb() {                             // "YYYY-MM-DDTHH" in Melbourne time
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}`;
}
const todayMelb = () => nowMelb().slice(0, 10);
const fmtDay = d => new Date(d + "T12:00:00Z").toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const hr = h => (h % 12 || 12) + (h % 24 < 12 ? "am" : "pm");
const hrsOf = s => { const [h, m] = s.slice(11, 16).split(":").map(Number); return h + m / 60; };

// ---------- Data ----------
const VARS = ["temperature_2m", "wind_speed_10m", "wind_direction_10m", "wind_gusts_10m", "precipitation"];

async function fetchEnsemble() {
  const url = "https://ensemble-api.open-meteo.com/v1/ensemble?" + new URLSearchParams({
    latitude: LAT, longitude: LON, hourly: VARS.join(","), models: "ecmwf_ifs025",
    forecast_days: 15, timezone: TZ, wind_speed_unit: "kmh",
  });
  const r = await fetch(url);
  if (!r.ok) throw new Error("Forecast service returned " + r.status);
  return r.json();
}
async function fetchSun() {                      // optional; falls back to 6am–8pm
  try {
    const r = await fetch("https://api.open-meteo.com/v1/forecast?" + new URLSearchParams({
      latitude: LAT, longitude: LON, daily: "sunrise,sunset", forecast_days: 16, timezone: TZ }));
    if (!r.ok) return {};
    const j = await r.json(), out = {};
    j.daily.time.forEach((d, i) => out[d] = [hrsOf(j.daily.sunrise[i]), hrsOf(j.daily.sunset[i])]);
    return out;
  } catch { return {}; }
}

// Split Open-Meteo's flat keys ("wind_speed_10m", "wind_speed_10m_member01", …) into members.
function toMembers(json) {
  const H = json.hourly, members = {};
  for (const key of Object.keys(H)) {
    const v = VARS.find(v => key === v || key.startsWith(v + "_member"));
    if (!v) continue;
    const m = key === v ? "00" : key.slice(v.length + 7);
    (members[m] ??= {})[v] = H[key];
  }
  return { time: H.time, members: Object.values(members).filter(m => m.wind_speed_10m && m.temperature_2m) };
}
const memberHour = (m, i) => ({ wind: m.wind_speed_10m[i], dir: m.wind_direction_10m?.[i] ?? 180, gust: m.wind_gusts_10m?.[i], temp: m.temperature_2m[i], rain: m.precipitation?.[i] ?? 0 });

function weekendBuckets({ time, members }) {
  const dates = [...new Set(time.map(t => t.slice(0, 10)))];
  const fridays = dates.filter(d => dowOf(d) === 5);
  const firstDow = dowOf(dates[0]);
  if (firstDow === 6 || firstDow === 0) fridays.unshift(addDays(dates[0], firstDow === 6 ? -1 : -2));
  return fridays.slice(0, 2).map(fri => ({ fri, blocks: BLOCKS.map(b => {
    const day = addDays(fri, { 5: 0, 6: 1, 0: 2 }[b.dow]);
    const idx = time.map((t, i) => [t, i]).filter(([t]) => t.slice(0, 10) === day && +t.slice(11, 13) >= b.start && +t.slice(11, 13) < b.end).map(([, i]) => i);
    if (!idx.length) return { ...b, day, missing: true };
    const scores = [], winds = [], gusts = [], dirs = [], temps = []; let wet = 0;
    for (const m of members) {
      let tot = 0, cnt = 0, rainy = false;
      for (const i of idx) {
        const h = memberHour(m, i);
        if (h.wind == null || h.temp == null) continue;
        tot += hourScore(h); cnt++; winds.push(h.wind); dirs.push(h.dir); temps.push(h.temp);
        if (h.gust != null) gusts.push(h.gust);
        if (h.rain >= 0.2) rainy = true;
      }
      if (cnt) { scores.push(tot / cnt); if (rainy) wet++; }
    }
    const lo = pctile(scores, .25), hi = pctile(scores, .75);
    return { ...b, day, scores, med: pctile(scores, .5), lo, hi, iqr: hi - lo, i0: idx[0],
      pRain: wet / members.length, wind: pctile(winds, .5), gust: gusts.length ? pctile(gusts, .5) : null,
      dir: circMean(dirs), temp: pctile(temps, .5),
      lead: Math.round((new Date(day) - new Date(dates[0])) / 864e5) };
  }) }));
}

if (typeof module !== "undefined") module.exports = {
  LAT, LON, TZ, BEACH_FACES, BLOCKS, TIERS, tierOf, dirFactor, curve, hourScore,
  dowOf, ymd, addDays, pctile, compass, circMean, nowMelb, todayMelb, fmtDay, hr, hrsOf,
  VARS, fetchEnsemble, fetchSun, toMembers, memberHour, weekendBuckets,
};
