# Geo Attendance: setup guide

Staff install the app once. When their phone comes within **500 m** of a workplace it **clocks them in automatically**. When it leaves that radius it **clocks them out**. Every record goes into a **Google Sheet** you control.

```
 Phone app (Android + iPhone)            Google Sheet (via Apps Script)
 ───────────────────────────             ─────────────────────────────
 Phone's own geofencing  ── ENTER/EXIT ──►  Attendance  (one row per shift)
 Offline queue (resends later)              Log         (every raw event)
 Manual Clock in / out (backup)             Staff       (who's registered, IN/OUT now)
 Pop-up: "Clocked in at MMRC 07:42"         Sites       (workplaces + radius)  ──► app
                                            Settings    (access code, grace period)
```

The app does **not** track people all day. The phone only wakes the app when it crosses a site boundary, and the app sends a location only with each clock-in or clock-out.

---

## Part A: Google Sheet backend (about 10 minutes)

1. Create a new Google Sheet, for example "Attendance 2026".
2. **Extensions → Apps Script**. Delete the sample code and paste in all of `backend/Code.gs`. Save.
3. In the function dropdown pick **`setup`** and click **Run**. Approve the permissions (it's your own script). Go back to the Sheet: it now has the tabs *Settings, Sites, Staff, Attendance, Log*.
4. **Sites tab:** add one row for each workplace.
   - To get the coordinates, open Google Maps, right-click the centre of the site and click the numbers at the top (for example `1.4045, 103.6984`) to copy them. Put the first number in *Latitude* and the second in *Longitude*.
   - *Radius (m)*: 500. *Active*: ticked.
5. **Settings tab:** change `ACCESS_CODE` from `CHANGE-ME` to your own code. Staff need this code to register.
6. **Deploy → New deployment →** gear icon **→ Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**. The app has no Google login, so this is required. The access code is what blocks strangers.
   - Click **Deploy** and **copy the Web app URL** (it ends in `/exec`).

> If you change `Code.gs` later, use **Deploy → Manage deployments → Edit → Version: New version**. That keeps the same URL, so the app keeps working.

## Part B: Put the URL into the app

Open `src/config.js` and paste the URL:

```js
export const BACKEND_URL = 'https://script.google.com/macros/s/AKfy...../exec';
```

You can also change `com.yourcompany.geoattendance` in `app.json` to your own ID, for example `com.junius.geoattendance`.

## Part C: Build the app and get it onto phones

You need a computer with **Node.js 20+** installed, plus a free **Expo account** (expo.dev). You **don't** need a Mac: iPhone builds run in Expo's cloud.

```bash
cd geo-attendance
npm install
npm install -g eas-cli
eas login
eas build:configure
```

### Android (free)

```bash
eas build --platform android --profile preview
```

When the build finishes you get a **download link for an .apk**. Send that link to staff (WhatsApp is fine). They open it and allow "Install unknown apps" when asked.

### iPhone

Apple doesn't allow installing apps from a plain link, so you need a paid **Apple Developer Program** account (**US$99/year**). An **organisation** account (it needs a company D-U-N-S number) shows the company name instead of yours, which is a good fit if Certis owns this.

```bash
eas build --platform ios --profile production
eas submit --platform ios
```

Then in **App Store Connect → TestFlight**, add staff by email or create a **public link**. Staff install Apple's free *TestFlight* app and then your app. TestFlight allows up to 10,000 people, but **each build expires after 90 days**, so you'll need to upload a new build every ~3 months. If you don't want that, you can publish to the App Store as an **unlisted app** later.

> **Expo Go won't work for this app.** Background location doesn't run inside Expo Go, so always test with a real build from the steps above.

## Part D: Each staff member's phone (important)

Automatic clock-in only works if the phone is allowed to wake the app. When staff install the app:

| | iPhone | Android |
|---|---|---|
| Location | Settings → Geo Attendance → Location → **Always**, and **Precise Location ON** | Location permission → **Allow all the time**, and **Use precise location ON** |
| Battery | Low Power Mode delays checks a little; that's OK | App info → Battery → **Unrestricted** (or "Don't optimise") |
| Extra (Xiaomi, Oppo, Vivo, Huawei, Samsung) | – | Turn on **Autostart**, and lock the app in the recent-apps screen. These phones kill background apps aggressively. |
| Notifications | Allow | Allow |

If location isn't set to "Always", the app shows a yellow **"Automatic clock-in is OFF"** bar with a **Fix** button.

---

## How it behaves

| Situation | What happens |
|---|---|
| Arrives within 500 m | Clocked in (Auto). The phone shows a pop-up. |
| Leaves the 500 m radius | Clocked out (Auto). Hours are worked out in the sheet. |
| GPS jumps out and back in within **10 min** (`GRACE_MINUTES`) | Treated as one shift; the gap is written in *Note*. This stops shifts being split by GPS drift. |
| No signal at the moment of entering or leaving | Saved on the phone with the real time and sent when signal returns. |
| Phone was off and missed the exit | The shift stays open. If it's still open after **16 h** (`MAX_SHIFT_HOURS`), it's marked **MISSING OUT** at the next clock-in so a supervisor can check it. |
| Opening the app while already inside a site | Clocks in if it hadn't yet (for example, on the first day). |
| Manual **Clock in** button | Only works within the site radius. Marked *Manual* in the sheet. |
| Manual **Clock out** button | Works anywhere and records "now". Marked *Manual*. |
| Staff member leaves the company | Untick **Allowed** on the *Staff* tab. Their app stops being accepted. |
| Lost access code / old installs | Change `ACCESS_CODE`. Everyone has to sign out and register again with the new code. |

**Timing accuracy:** iPhones usually report crossing the boundary within about a minute. Android phones can take **2–5 minutes**, more on phones with heavy battery saving. Clock-out time is when they *cross 500 m*, not when they leave the building.

## Before you roll it out

- **Get it approved.** Collecting staff location counts as personal data under Singapore's PDPA. Tell staff what's collected (location only at clock-in/out), why, and get their consent. Check with HR / management that this is allowed alongside the official attendance system.
- **Check site phone rules.** Some protected areas restrict phones or location services. If phones are kept in lockers, the clock-in happens at the locker. That's fine, but it's worth knowing.
- **Pilot it** with 2–3 people (both Android and iPhone) for a week. Compare the sheet against the actual times before rolling it out to everyone.

## Testing tips

- To test without driving 500 m away, add a temporary site in the *Sites* tab with a **small radius around your home or desk** (100–150 m works best; smaller is unreliable). Pull down to refresh in the app so it downloads the new site, then walk out and back in.
- The **Log** tab shows every event the server received and what it decided ("Clocked in", "Already clocked in", "Back within grace period…"). Check it first when something looks wrong.

## Files

```
geo-attendance/
├── App.js               screens (setup + home)
├── index.js             app entry; loads the background task first
├── src/attendance.js    geofencing, offline queue, talks to the sheet
├── src/config.js        ← paste your Web app URL here
├── app.json             permissions + app name/ID
├── eas.json             build profiles (Android APK, iOS TestFlight)
└── backend/Code.gs      paste into Apps Script
```
