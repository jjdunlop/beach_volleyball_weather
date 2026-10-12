// Checks the upcoming weekend buckets and sends a push notification (ntfy) when one turns Epic,
// or drops back out of Epic. Runs on a schedule from .github/workflows/alerts.yml.
//
// Env:
//   NTFY_TOPIC      ntfy topic to publish to (required to send; without it, messages are only printed)
//   NTFY_SERVER     default https://ntfy.sh
//   PAGE_URL        link opened when the notification is tapped (optional)
//   TEST_NOTIFY=1   also send the current weekend summary now, to check notifications work
//   FRIDAY_SUMMARY  set to "false" to turn off the Friday-morning weekend summary
//   MAX_LEAD_DAYS   only alert for buckets this many days ahead or fewer (default 5)
//   FIXTURE, NOW    testing only: read forecast JSON from a file; pretend the time is "YYYY-MM-DDTHH"

const fs = require("fs");
const path = require("path");
const S = require("../scoring.js");

const STATE_FILE = path.join(__dirname, "..", "alert-state.json");
const MAX_LEAD = Number(process.env.MAX_LEAD_DAYS || 5);
const EPIC = S.TIERS.find(t => t.key === "epic").min;   // median must be Epic...
const FLOOR = S.TIERS.find(t => t.key === "go").min;    // ...and the lower quartile at least Solid

function isEpic(b) { return b.med >= EPIC && b.lo >= FLOOR; }

function describe(b) {
  const t = S.tierOf(b.med);
  return `${t.label} ${b.med.toFixed(1)}/10 (likely ${b.lo.toFixed(1)}–${b.hi.toFixed(1)}) · ` +
    `${Math.round(b.wind)} km/h ${S.compass(b.dir)}, gusts ${b.gust != null ? Math.round(b.gust) : "?"} · ` +
    `${Math.round(b.temp)}°C (feels ${Math.round(b.feels)}) · rain ${Math.round(b.pRain * 100)}% · gusty ${Math.round(b.pGusty * 100)}%`;
}

async function notify({ title, message, priority = 3, tags = ["volleyball"] }) {
  const topic = process.env.NTFY_TOPIC;
  console.log(`\n[notify] ${title}\n${message}`);
  if (!topic) { console.log("(NTFY_TOPIC not set: not sent)"); return; }
  const body = { topic, title, message, priority, tags };
  if (process.env.PAGE_URL) body.click = process.env.PAGE_URL;
  const r = await fetch(process.env.NTFY_SERVER || "https://ntfy.sh", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`ntfy returned ${r.status}: ${await r.text()}`);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

async function main() {
  const now = process.env.NOW || S.nowMelb();
  const today = now.slice(0, 10), hour = +now.slice(11, 13);
  const json = process.env.FIXTURE ? JSON.parse(fs.readFileSync(process.env.FIXTURE, "utf8")) : await S.fetchEnsemble();
  const data = S.toMembers(json);
  if (!data.members.length) throw new Error("Forecast had no ensemble members");
  const weekends = S.weekendBuckets(data);

  const old = loadState();
  const state = { buckets: {}, lastSummary: old.lastSummary ?? null,
    // Updated once a week so the repo stays active and GitHub keeps running the schedule.
    week: S.addDays(today, -((S.dowOf(today) + 6) % 7)) };

  const upcoming = weekends.flatMap(w => w.blocks).filter(b => !b.missing && b.scores?.length &&
    (b.day > today || (b.day === today && b.playEnd > hour)));   // dark buckets have no scores, so never alert
  const leadOf = b => Math.round((new Date(b.day) - new Date(today)) / 864e5);

  const turnedEpic = [], droppedOut = [];
  for (const b of upcoming) {
    const key = `${b.day} ${b.name}`, prev = old.buckets?.[key], epic = isEpic(b);
    if (leadOf(b) > MAX_LEAD) { if (prev) state.buckets[key] = prev; continue; }
    state.buckets[key] = { epic, med: +b.med.toFixed(1) };
    if (epic && !prev?.epic) turnedEpic.push(b);
    else if (!epic && prev?.epic) droppedOut.push(b);
  }
  const when = b => `${S.fmtDay(b.day)}, ${S.hr(b.playStart)}–${S.hr(b.playEnd)}`;
  const ahead = b => { const n = leadOf(b); return n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`; };
  if (turnedEpic.length) await notify({
    title: `${turnedEpic.map(b => b.name).join(" + ")} looks EPIC (${ahead(turnedEpic[0])})`,
    message: turnedEpic.map(b => `${when(b)}\n${describe(b)}`).join("\n\n"), priority: 4, tags: ["volleyball", "sunny"] });
  if (droppedOut.length) await notify({
    title: `${droppedOut.map(b => b.name).join(" + ")} no longer epic`,
    message: droppedOut.map(b => `${when(b)}\nNow ${describe(b)}`).join("\n\n") });

  // Friday-morning summary of this weekend, and the manual test message.
  const thisWeekend = upcoming.filter(b => leadOf(b) <= 2);
  const summary = () => thisWeekend.map(b => `${b.name}: ${describe(b)}`).join("\n") || "No buckets left this weekend.";
  if (process.env.FRIDAY_SUMMARY !== "false" && S.dowOf(today) === 5 && hour < 12 && old.lastSummary !== today) {
    await notify({ title: "Beach volley this weekend", message: summary() });
    state.lastSummary = today;
  }
  if (process.env.TEST_NOTIFY === "1") {
    await notify({ title: "Test: beach volley alerts are working", message: upcoming.length ?
      upcoming.slice(0, 5).map(b => `${S.fmtDay(b.day)} ${b.name}: ${describe(b)}`).join("\n") : "No upcoming buckets in the forecast." });
  }

  const out = JSON.stringify(state, null, 2) + "\n";
  if (out !== (fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, "utf8") : "")) fs.writeFileSync(STATE_FILE, out);
  console.log(`\nChecked ${upcoming.length} upcoming buckets at ${now}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
