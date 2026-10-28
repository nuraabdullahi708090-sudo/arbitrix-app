'use strict';

/**
 * Turns scripts/tutorial/scenes.json into per-scene narration audio and the
 * timing plan the recorder follows, so the picture always matches the voice.
 *
 *   node scripts/tutorial/narrate.js
 *   node scripts/tutorial/narrate.js --voice en-US-GuyNeural --force
 *
 * The narration is male by default (en-US-AndrewNeural); --force re-synthesises
 * even when files already exist, which is what a voice change needs.
 *
 * Writes <out>/audio/scene-<id>.mp3 and <out>/timeline.json.
 * Requires the optional dev tool: npm i --no-save msedge-tts
 * (Any other TTS can be used instead - drop scene-<id>.mp3 into <out>/audio and
 * run with --plan-only, which skips synthesis and only measures the files.)
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const LEAD_SEC = 0.45;
const TAIL_SEC = 1.25;

function bin(envVar, moduleName, fallback) {
  if (process.env[envVar]) return process.env[envVar];
  try {
    const mod = require(path.join(ROOT, 'node_modules', moduleName));
    return typeof mod === 'string' ? mod : mod.path || fallback;
  } catch (error) {
    return fallback;
  }
}

const FFMPEG = bin('FFMPEG_PATH', 'ffmpeg-static', 'ffmpeg');
const FFPROBE = bin('FFPROBE_PATH', 'ffprobe-static', 'ffprobe');

function parseArgs(argv) {
  const args = { out: path.join(ROOT, 'build', 'video', 'deposit-tutorial'), voice: '', planOnly: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--voice') args.voice = argv[++i];
    else if (a === '--plan-only') args.planOnly = true;
    else if (a === '--force') args.force = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function duration(file) {
  const out = execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return parseFloat(String(out).trim());
}

async function synthesize(scenes, voice, audioDir) {
  let MsEdgeTTS;
  let OUTPUT_FORMAT;
  try {
    ({ MsEdgeTTS, OUTPUT_FORMAT } = require(path.join(ROOT, 'node_modules', 'msedge-tts')));
  } catch (error) {
    console.error(
      'msedge-tts is not installed. Install it (npm i --no-save msedge-tts) or supply your own\n' +
      'scene-<id>.mp3 files in ' + audioDir + ' and run again with --plan-only.'
    );
    return false;
  }
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  for (const scene of scenes) {
    const { audioStream } = await tts.toStream(scene.say);
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on('data', (c) => chunks.push(c));
      audioStream.on('end', resolve);
      audioStream.on('error', reject);
    });
    fs.writeFileSync(path.join(audioDir, `scene-${scene.id}.mp3`), Buffer.concat(chunks));
    console.log('narrated scene', scene.id);
  }
  return true;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }

  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'scenes.json'), 'utf8'));
  const voice = args.voice || config.voice;
  const audioDir = path.join(args.out, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });

  const missing = args.force
    ? config.scenes.slice()
    : config.scenes.filter((s) => !fs.existsSync(path.join(audioDir, `scene-${s.id}.mp3`)));
  if (missing.length && args.planOnly) {
    console.error('missing narration for scenes: ' + missing.map((s) => s.id).join(', '));
    return 2;
  }
  if (missing.length && !(await synthesize(config.scenes, voice, audioDir))) return 2;
  if (!missing.length) console.log('using the narration already in ' + audioDir);

  const timeline = config.scenes.map((scene) => {
    const audio = path.join(audioDir, `scene-${scene.id}.mp3`);
    const audioSec = duration(audio);
    return { id: scene.id, caption: scene.caption, audio, audioSec, ms: Math.round((audioSec + LEAD_SEC + TAIL_SEC) * 1000) };
  });
  fs.writeFileSync(path.join(args.out, 'timeline.json'), JSON.stringify(timeline, null, 2));

  const total = timeline.reduce((a, b) => a + b.ms, 0);
  console.log(timeline.map((t) => `scene ${t.id}: ${(t.ms / 1000).toFixed(2)}s`).join('  '));
  console.log('planned duration:', (total / 1000).toFixed(1) + 's');
  return 0;
})()
  .then((code) => process.exit(code))
  .catch((error) => { console.error('narrate failed:', error.message); process.exit(1); });
