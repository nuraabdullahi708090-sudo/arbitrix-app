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

## What is needed to finish it

1. A **MARKETING_SANDBOX** account on the target environment. It can only be
   created by an administrator (`POST /api/admin/sandbox/accounts`); public
   registration always produces a PRODUCTION account.
2. A **saved browser session** for that account: cookies + `localStorage` for the
   site, exported as JSON. No password and no service key is needed or accepted.
3. The two commands:

```bash
npm i --no-save puppeteer-core msedge-tts ffmpeg-static ffprobe-static
node scripts/tutorial/record.js --live --url https://arbitrix.pro \
     --storage-state ./sandbox-session.json --out build/video/deposit-tutorial-live
node scripts/tutorial/build.js --out build/video/deposit-tutorial-live --share
```

In live mode the recorder stops at the payment screen, waits for the sandbox to
credit on its own (30 s), and records the waiting state if it does not. It never
submits a payment, never deposits funds and never touches production data. It
creates at most one sandbox invoice, which is the step being demonstrated.

## Publishing (not done, needs approval)

The repository keeps shipped videos in `public/video/` and commits them. Nothing
was copied there and nothing was published. After review:

```bash
cp build/video/deposit-tutorial-live/arbitrix-deposit-tutorial-en.mp4 public/video/
```

## Getting the session file (precise checklist)

The recorder needs a MARKETING_SANDBOX account already logged in, exported as a
Playwright/Puppeteer storage-state file. It does **not** need a password, an admin
JWT or a service key.

1. An administrator creates the sandbox account (`POST /api/admin/sandbox/accounts`).
   Public registration always produces a PRODUCTION account, so there is no other way.
2. In that browser profile, log in to the target environment and confirm the
   "PREVIEW" badge is visible (proof it is the sandbox account, not a customer).
3. Open DevTools -> Console on `https://arbitrix.pro` and run:

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

4. Move the file **outside the repository** (e.g. `~/arbitrix-sandbox-session.json`)
   and `chmod 600` it. It contains the account's login token, so treat it like a
   password: never commit it, never paste it into a chat or an issue.
5. Run the two commands above. The recorder refuses a file with no `jwt_token`
   and warns if the file sits inside the repo.

`cookies: []` is correct for this app: the session lives in `localStorage`
(`jwt_token`), not in an httpOnly cookie. Adding cookies does no harm.

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
