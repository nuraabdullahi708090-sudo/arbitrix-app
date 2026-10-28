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

## Telegram integration (designed, NOT wired)

Deliberately not implemented yet: it depends on an approved, published video. The
plan, so it can be done in one small change:

1. Host the approved MP4 at a public HTTPS URL (the `public/video/` path above),
   or upload it once and store the returned Telegram `file_id`.
2. In `services/TelegramSupportService.js`, the deposit intent already exists in
   `replyFor()`/the keyword table. Add one reply that keeps the existing text
   guidance and appends a `sendVideo` with the tutorial (caption localized in
   `services/telegram-i18n.js`: en/pt/ar), rather than replacing the text.
3. Add a transport method `sendVideo(chatId, video, { caption })` next to
   `sendMessage` in the existing transport, reusing its error/retry handling.
4. Gate it behind its own env flag (e.g. `TELEGRAM_DEPOSIT_TUTORIAL_URL`) so an
   unset value keeps today's behaviour exactly.
5. Tests: extend `tests/telegram_support_bot.test.js` for the new intent reply and
   assert that with the flag unset the reply is byte-identical to today's.

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
