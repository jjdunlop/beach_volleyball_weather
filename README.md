# South Melbourne Beach Volley

Rates how worth it beach volleyball at South Melbourne Beach will be, hour by hour, 0–10, from the ECMWF 51-member ensemble (via [Open-Meteo](https://open-meteo.com), free for non-commercial use). Sends a push notification when a weekend session is forecast to be Epic.

- `index.html`: the forecast page (timeline, best windows, weekend buckets, past weekends).
- `scoring.js`: settings and scoring shared by the page and the alerts. Tune thresholds here.
- `scripts/alert.js`: checks the weekend buckets and sends notifications through [ntfy](https://ntfy.sh).
- `.github/workflows/alerts.yml`: runs the alert check twice a day (about 8am and 8pm Melbourne time).
- `alert-state.json`: written by the workflow so it only notifies on changes. Don't edit by hand.

## Setup

1. **Host the page.** Settings → Pages → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`. The page appears at `https://jjdunlop.github.io/beach_volleyball_weather/`.
2. **Get the ntfy app** (iOS or Android) and subscribe to a topic name nobody will guess, e.g. `smb-volley-7f3k9q`. Anyone who knows the topic name can read it, so share it with friends who want the alerts and nobody else.
3. **Add the topic as a secret.** Settings → Secrets and variables → Actions → *New repository secret*: name `NTFY_TOPIC`, value your topic name.
4. **Optional: make notifications open the page.** Same screen, *Variables* tab → `PAGE_URL` = the Pages URL from step 1.
5. **Test it.** Actions → *Epic alerts* → *Run workflow* (leave "Send a test notification" ticked). Your phone should get the current weekend outlook within a minute.

## What triggers a notification

- A weekend bucket (Fri night, Sat midday, Sat arvo, Sun midday, Sun arvo) up to 5 days ahead turns **Epic**: median rating ≥ 8.5 and the lower quartile of ensemble members ≥ 7, so most members agree.
- A bucket that was Epic drops out.
- Friday morning: a summary of all five buckets (set `FRIDAY_SUMMARY: "false"` in the workflow env to turn off).

GitHub may start scheduled runs 10–30 minutes late. The state file is committed at least weekly, which keeps the schedule from being paused for inactivity.

## Running the alert check locally

```sh
NTFY_TOPIC=your-topic node scripts/alert.js            # real run
TEST_NOTIFY=1 node scripts/alert.js                     # print/send the current outlook
```

Without `NTFY_TOPIC` the script only prints what it would send.
