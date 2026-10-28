# Deposit tutorial recorder

Records the customer deposit journey (Demo -> Live -> deposit -> credited) from the
**shipped** `public/index.html`, narrates it, and produces a share-ready MP4.
Everything here is a working tool: it is not imported by the app or by any test.

## What the recording contains

- **Male narration** by default (`en-US-AndrewNeural`, fallback `en-US-GuyNeural`),
  written for a first-time customer: no jargon, no promises, no earnings claims.
- **A step chip** at the top of every scene (`STEP 3 OF 8 - Open the deposit window`).
- **A highlight ring**: the page dims around the exact control being described
  (the amount field, the address block, the status box, the support button) with a
  pulsing gold ring. The ring is clamped to the viewport so a tall panel can never
  produce a full-screen box, and the target is scrolled into view first.
- **Burned-in subtitles** in one cue per scene, plus `subtitles.srt` as a sidecar
  for players, re-edits and translations.

## Pipeline

```bash
# 1. narration + timing plan (writes <out>/audio/scene-*.mp3 and <out>/timeline.json)
node scripts/tutorial/narrate.js            # add --force after changing the voice
node scripts/tutorial/narrate.js --voice en-US-GuyNeural --force   # alternative male voice

# 2. screen recording (writes <out>/frames/*.png and <out>/frames.json)
node scripts/tutorial/record.js

# 3. encode + verify (+ share copies)
node scripts/tutorial/build.js --share
```

Default `<out>` is `build/video/deposit-tutorial`, which is **not** committed.
Optional dev tools, installed on demand (never added to `package.json`):

```bash
npm i --no-save puppeteer-core msedge-tts ffmpeg-static ffprobe-static
# a Chromium binary is also required; CHROMIUM_PATH defaults to /usr/bin/chromium
# FFMPEG_PATH / FFPROBE_PATH override the static builds
```

Any TTS can replace `narrate.js`: drop `scene-<id>.mp3` files into `<out>/audio`
and run `node scripts/tutorial/narrate.js --plan-only` to measure them.

## Two recording modes, and which one you are looking at

| Mode | Command | Data on screen | Honest to publish? |
|---|---|---|---|
| stub (default) | `node scripts/tutorial/record.js` | Placeholder invoice `DEMO-INVOICE-0001`, address `TDEMONSTRATIONONLYDONOTSEND...`, balances 1000/50 -> 150, plus a permanent "Simulated data - not a real payment" badge | **No.** Internal draft only |
| live | `node scripts/tutorial/record.js --live --url https://arbitrix.pro --storage-state ./sandbox-session.json` | Real MARKETING_SANDBOX account: genuine sandbox address, invoice and balances; no badge | Yes, after review |

The stub mode exists so the pipeline can be run and reviewed without credentials.
It is deliberately self-labelling: `build.js` prints `recording mode: stub,
disclosure badge: YES`, so a draft can never be mistaken for a sandbox recording.

## What a production-ready (live) recording needs

1. A **MARKETING_SANDBOX** account on the target environment (admin-created via
   `POST /api/admin/sandbox/accounts`; it is classified server-side and cannot be
   created by public registration).
2. A **saved browser session** for that account - cookies + `localStorage` for the
   site exported as JSON. Pass it with `--storage-state`; never send a password or
   a service key. `record.js` refuses to record if the session does not reach the
   dashboard.
3. Nothing else: the sandbox has no KYC, no minimum withdrawal and a simulated
   deposit pipeline, so no real funds are involved.

## Two things the recorder deliberately controls

- The **one-time onboarding funnel** is dismissed and marked answered for the
  account before recording: the tutorial teaches the deposit journey to a
  returning user, and the funnel modal would otherwise sit on top of the deposit
  modal (a stray click on it even switches the app back to Demo Mode).
- The **amount field** is verified before and after typing. If any overlay covers
  it, the recorder throws `the amount field is covered by "<element>"` instead of
  recording a video in which nothing was actually typed.

## Safety rules the recorder follows

- It never submits a payment. In live mode it stops at the payment screen and
  waits for the sandbox to credit on its own; if that does not happen within 30 s
  it records the "waiting for payment" state and says so.
- It creates at most one invoice (the deposit step), and only because that is the
  step being demonstrated.
- It never touches production deposits, withdrawals, balances or the marketing
  publisher, and it does not call any test-send endpoint.

## Output and verification

`build.js` encodes `arbitrix-deposit-tutorial-en.mp4` (1280x720, h264 yuv420p,
30 fps, AAC 48 kHz mono, `+faststart`) and then checks, failing the run if any
check fails:

- the file decodes without errors;
- video is h264/yuv420p and an AAC audio stream is present;
- the duration matches the recorded timeline within 2 s;
- **narration is audible in every scene** (mean volume above -60 dB);
- **every scene still is visually distinct** (8 unique images);
- **subtitles are written, well formed, and actually render** (a one-frame
  libass probe proves the font and style work before the encode is trusted).

The MP4 also carries `subtitles.srt` beside it, and `--share` copies it next to
the WhatsApp/Telegram versions.

## Sharing (WhatsApp / Telegram)

`--share` writes `share/<name>-whatsapp.mp4` and `share/<name>-telegram.mp4`
(CRF 23-24, mono 96 kbit/s audio, `+faststart`, no change to resolution or
duration) plus `share/caption.txt`.

Both messengers accept a plain MP4 upload of this size; no special codec is
required. WhatsApp's document limit is 2 GB but media playback is most reliable
under ~64 MB, Telegram's bot upload limit is 50 MB - this file is far below both.

**Do not** copy the result into `public/video/` and do not commit it: that
directory is served publicly, so adding a file there publishes it. Promotion to
`public/video/` (which *is* where the repo keeps its shipped videos, e.g.
`arbitrix-partner-payout-demo.mp4`) needs explicit authorisation, and then:

```bash
cp build/video/deposit-tutorial/arbitrix-deposit-tutorial-en.mp4 public/video/
```

## What is placeholder in the current draft

The committed draft (`build/video/deposit-tutorial/arbitrix-deposit-tutorial-en.mp4`,
stub mode) is honest about itself, but these elements are NOT real:

| Element | Draft value | What a live recording gives |
|---|---|---|
| Invoice reference | `DEMO-INVOICE-0001` | the sandbox's own invoice id |
| Payment address / QR | `TDEMONSTRATIONONLYDONOTSEND...` | the sandbox TRC20 payout address |
| Live balance before / after | `$50.00` -> `$150.00` | the sandbox wallet's real figures |
| Chain confirmation | simulated poll (pending -> credited) | whatever the sandbox actually reports |
| Account / name | `tutorial@example.invalid`, "Alex Morgan" | the sandbox account |
| Badge | "Simulated data - not a real payment" | absent |

Everything else is genuine: the page is `public/index.html` as shipped, so every
screen, label, translation, QR widget and status string is the real product.

## Re-recording after a UI change

Scene captions and narration live in `scenes.json`; the UI steps the recorder
performs are `actions` in `record.js`. If a selector changes, `record.js` fails
loudly (it asserts the amount field, the payment section, and the credited
status) instead of producing a silently wrong video.
