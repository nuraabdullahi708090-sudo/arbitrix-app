# Deposit tutorial video

Status: **draft only**. The recording pipeline is finished and tested, but the
published-worthy version must be shot on a real MARKETING_SANDBOX account. That
recording has **not** been made: no sandbox credentials or browser session exist
in this environment.

## What exists

| File | Purpose |
|---|---|
| `scripts/tutorial/scenes.json` | 8 scenes: step title, subtitle, narration, highlight target |
| `scripts/tutorial/narrate.js` | Edge TTS narration (male) + the timing plan |
| `scripts/tutorial/record.js` | drives the shipped `public/index.html`, captures frames |
| `scripts/tutorial/build.js` | burns subtitles, encodes, verifies, writes share copies |
| `scripts/tutorial/README.md` | how to run it, and which mode is publishable |

Outputs live under `build/video/deposit-tutorial/` (not committed):

```
arbitrix-deposit-tutorial-en.mp4     1280x720, h264, 30fps, AAC, 80.7s, +faststart
subtitles.srt                        one cue per scene
share/arbitrix-deposit-tutorial-en-whatsapp.mp4
share/arbitrix-deposit-tutorial-en-telegram.mp4
share/subtitles.srt
share/caption.txt
```

The draft is honest about itself: a permanent "Simulated data - not a real
payment" badge, invoice `DEMO-INVOICE-0001`, address
`TDEMONSTRATIONONLYDONOTSEND...`, and `build.js` prints
`recording mode: stub, disclosure badge: YES`.

## Administrator: create the sandbox account (step 1 of 2)

Sandbox accounts are admin-only. Public registration always produces a PRODUCTION
account, so there is no other route and none should be invented.

```bash
# <admin JWT> is an administrator session token. Pass it, never print it.
curl -X POST https://arbitrix.pro/api/admin/sandbox/accounts \
  -H "Authorization: Bearer <admin JWT>" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Tutorial recording"}'
```

Response (the password is shown ONCE - hand it to the operator over a secure
channel, do not paste it into a ticket or a chat log):

```json
{ "success": true,
  "account": { "id": 123, "name": "Tutorial recording",
               "email": "marketing-demo+xxxx@sandbox.arbitrix.invalid",
               "environment": "MARKETING_SANDBOX" },
  "credentials": { "email": "...", "password": "..." } }
```

Optional body fields: `email` (a fixed address instead of the generated one),
`referralCode` (attribute the account to an existing sandbox partner).

## What "genuine credit" means here (read before recording)

A MARKETING_SANDBOX account is a real account row whose money is simulated: the
deposit flow, the invoice, the status progression and the wallet credit are the
**real application code** running against `sandbox_*` tables, with no blockchain
payment behind them. So the recording must be:

- **genuine** in the sense that it is the real UI, the real API and a real sandbox
  credit event - not a mocked screen and not a hand-edited video; and
- **labelled**, because no USDT was actually sent anywhere.

Pass the disclosure so the video says so on screen:

```bash
--disclosure "Sandbox demo account - simulated credit"
```

Do not describe a sandbox credit as a real payment, and do not claim a deposit was
made if the status never reaches `credited`.

## Operator: export the browser session (step 2 of 2)

1. Log in to `https://arbitrix.pro` **as the sandbox account** in a private window.
2. Confirm the **PREVIEW** badge is visible. That badge is the proof you are on a
   sandbox account and not a customer account; if it is not there, stop.
3. Export the session from DevTools -> Console (the app keeps its JWT in
   `localStorage`; there is no httpOnly cookie to capture):

`cookies: []` is correct for this app: the session lives in `localStorage`
(`jwt_token`), not in an httpOnly cookie; adding cookies does no harm.

```js
(() => {
  const origins = [{ origin: location.origin,
    localStorage: Object.keys(localStorage).map((name) => ({ name, value: localStorage.getItem(name) })) }];
  const blob = new Blob([JSON.stringify({ cookies: [], origins }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sandbox-session.json';
  a.click();
})();
```

4. Move it **outside the repository** and lock it down:
   `mv ~/Downloads/sandbox-session.json ~/arbitrix-sandbox-session.json && chmod 600 ~/arbitrix-sandbox-session.json`
5. Record:

```bash
npm i --no-save puppeteer-core msedge-tts ffmpeg-static ffprobe-static
node scripts/tutorial/record.js --live --url https://arbitrix.pro \
     --storage-state ~/arbitrix-sandbox-session.json \
     --disclosure "Sandbox demo account - simulated credit" \
     --out build/video/deposit-tutorial-live
node scripts/tutorial/build.js --out build/video/deposit-tutorial-live --share
```

The recorder refuses a state file with no `jwt_token` (it would otherwise shoot
the login page) and warns if the file sits inside the repo. `.gitignore` already
blocks `sandbox-session*.json` / `storage-state*.json`.

In live mode it creates at most one sandbox invoice - the step being demonstrated -
then waits up to 30 s for the sandbox to credit on its own and records the waiting
state if it does not. It never submits a payment, never funds anything and never
touches a production account.

## Session hygiene (after the recording)

- The file is a login credential: treat it like a password. Never commit, paste,
  screenshot or attach it.
- Delete it once the recording is done: `rm -f ~/arbitrix-sandbox-session.json`.
- Log the sandbox account out (or change its password) so the exported token stops
  working, then reset the sandbox account before the next recording.
- Never export a customer's session, and never use a real user's account.

## What the finished video must show (review checklist)

1. Dashboard in Demo Mode, then the switch to Live Mode.
2. The deposit window with the minimum deposit visible.
3. The amount typed, then the generated payment screen.
4. The address / QR / exact amount instructions exactly as the app renders them.
5. The status moving to **credited** for **that** invoice, on camera.
6. The Live balance matching the deposited amount afterwards.
7. The support screen as the last scene.
8. The disclosure on screen for the whole video.

## Publishing (not done, needs approval)

The repository keeps shipped videos in `public/video/` and commits them. Nothing
was copied there and nothing was published. After review:

```bash
cp build/video/deposit-tutorial-live/arbitrix-deposit-tutorial-en.mp4 public/video/
```

## Telegram integration (implemented, DISABLED by default)

The plumbing ships now, switched off. `TELEGRAM_DEPOSIT_TUTORIAL_URL` unset (or any
non-https value) leaves every reply byte-identical to the text-only behaviour.

1. Only after the video is approved AND published, set
   `TELEGRAM_DEPOSIT_TUTORIAL_URL` to its absolute https URL on the web service.
2. Then a customer question answered from the `deposits` knowledge category gets
   the existing text answer first, followed by ONE video with a localized caption
   (en/pt/ar, `tutorialCaption`). Non-deposit questions never get it.
3. The video is best-effort: if Telegram rejects it, the text answer stands and
   the update still succeeds (no 500, no redelivery, no duplicate reply).
4. Verified by `tests/telegram_deposit_tutorial.test.js` (13 tests): disabled
   default, https-only gate, deposit-intent matching, text-first ordering, one
   video per message, non-deposit silence, send failure tolerance, transport
   without `sendVideo`, AI-off behaviour, and caption localization.

Do NOT point the variable at the draft: it is a labelled stub and `public/video/`
is untouched.

## Verification performed on the draft

`build.js` fails the run unless all of these pass:

- decodes without errors; h264/yuv420p; AAC audio present;
- duration matches the recorded timeline within 2 s;
- narration is audible in **every** scene (volumedetect mean above -60 dB);
- 8 visually distinct scene stills;
- subtitles are well formed and libass + the chosen font actually render them.

Additional checks run by hand on the finished file: gold highlight ring present in
all 8 scenes (pixel count along each recorded ring rect), step chip present at the
top of all 8 scenes, subtitle text present at the bottom of all 8 scenes.

Not verified, and cannot be from here: that the video shows a **real** sandbox
credit. That is exactly what the live recording adds.
