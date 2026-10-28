'use strict';

/**
 * Encodes the recorded frames + narration into the tutorial MP4 and verifies it.
 *
 *   node scripts/tutorial/build.js
 *   node scripts/tutorial/build.js --share          # also writes WhatsApp/Telegram copies
 *
 * Inputs (all under <out>, default build/video/deposit-tutorial):
 *   frames/frame-*.png   from record.js
 *   frames.json          timestamps + per-scene marks from record.js
 *   audio/scene-*.mp3    from narrate.js
 *
 * Outputs:
 *   arbitrix-deposit-tutorial-en.mp4                master
 *   share/<name>-whatsapp.mp4, share/<name>-telegram.mp4, share/caption.txt
 *
 * Every step is deterministic: same frames + same audio = same file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

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
  const args = {
    out: path.join(ROOT, 'build', 'video', 'deposit-tutorial'),
    name: 'arbitrix-deposit-tutorial-en',
    share: false,
    verifyOnly: false,
    fps: 30,
    crf: 20
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--name') args.name = argv[++i];
    else if (a === '--fps') args.fps = Number(argv[++i]);
    else if (a === '--crf') args.crf = Number(argv[++i]);
    else if (a === '--share') args.share = true;
    else if (a === '--verify-only') args.verifyOnly = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

const run = (binPath, argv) => execFileSync(binPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
const probe = (file, entries) => String(execFileSync(FFPROBE, ['-v', 'error', ...entries, '-of', 'default=nw=1', file])).trim();

const SUBTITLE_STYLE = [
  'FontName=DejaVu Sans',
  'FontSize=22',
  'PrimaryColour=&H00FFFFFF',
  'OutlineColour=&H90000000',
  'BackColour=&H90000000',
  'BorderStyle=1',
  'Outline=2',
  'Shadow=0',
  'Alignment=2',
  'MarginV=26'
].join(',');

const srtClock = (ms) => {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const sec = Math.floor((total % 60000) / 1000);
  const millis = total % 1000;
  const pad = (n, w) => String(n).padStart(w, '0');
  return pad(h, 2) + ':' + pad(m, 2) + ':' + pad(sec, 2) + ',' + pad(millis, 3);
};

// One cue per scene, held for the whole scene so the subtitle never flickers
// between sentences: the recording is a walkthrough, not a film.
function buildSrt(capture, timeline) {
  const cues = [];
  capture.marks.forEach((mark, index) => {
    const scene = timeline.find((t) => t.id === mark.id);
    if (!scene || !scene.caption) return;
    cues.push({
      index: index + 1,
      start: mark.startMs,
      end: mark.endMs,
      text: scene.caption.replace(/\s+/g, ' ').trim()
    });
  });
  return cues
    .map((cue) => cue.index + '\n' + srtClock(cue.start) + ' --> ' + srtClock(cue.end) + '\n' + cue.text + '\n')
    .join('\n');
}

function escapeFilterPath(file) {
  // libass takes the path inside a filter graph: escape the separators it uses.
  return file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); return 0; }

  const framesJson = path.join(args.out, 'frames.json');
  const audioDir = path.join(args.out, 'audio');
  const timelinePath = path.join(args.out, 'timeline.json');
  for (const required of [framesJson, audioDir, timelinePath]) {
    if (!fs.existsSync(required)) {
      console.error('missing input: ' + required + ' (run narrate.js, then record.js)');
      return 2;
    }
  }

  const capture = JSON.parse(fs.readFileSync(framesJson, 'utf8'));
  const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8'));
  if (!capture.count) { console.error('no frames recorded'); return 2; }

  const masterPath = path.join(args.out, args.name + '.mp4');
  if (args.verifyOnly) {
    if (!fs.existsSync(masterPath)) { console.error('nothing to verify: ' + masterPath); return 2; }
    return verify(args, capture, masterPath);
  }

  // 1. frame timeline: real capture cadence, so no drift against the narration
  const lines = [];
  for (let i = 0; i < capture.count; i += 1) {
    const next = i + 1 < capture.count ? capture.timestamps[i + 1] : capture.timestamps[i] + 300;
    lines.push(`file '${path.join(args.out, 'frames', 'frame-' + String(i + 1).padStart(5, '0') + '.png')}'`);
    lines.push('duration ' + Math.max((next - capture.timestamps[i]) / 1000, 0.02).toFixed(3));
  }
  lines.push(`file '${path.join(args.out, 'frames', 'frame-' + String(capture.count).padStart(5, '0') + '.png')}'`);
  const framesList = path.join(args.out, 'frames.txt');
  fs.writeFileSync(framesList, lines.join('\n') + '\n');

  // 2. narration padded to the ACTUAL scene length, so audio and picture agree
  const audioList = [];
  for (const mark of capture.marks) {
    const scene = timeline.find((t) => t.id === mark.id);
    if (!scene) continue;
    const seconds = (mark.endMs - mark.startMs) / 1000;
    const out = path.join(audioDir, `seg-${mark.id}.wav`);
    run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono',
      '-i', scene.audio, '-filter_complex', `[1:a]adelay=450|450,apad[a]`,
      '-map', '[a]', '-t', seconds.toFixed(3), '-ar', '48000', '-ac', '1', out]);
    audioList.push(`file '${out}'`);
  }
  const audioListFile = path.join(audioDir, 'list.txt');
  fs.writeFileSync(audioListFile, audioList.join('\n') + '\n');
  const fullAudio = path.join(audioDir, 'full.wav');
  run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', audioListFile, '-ar', '48000', '-ac', '1', fullAudio]);

  // 3. subtitles, then encode with them burned in (the SRT is kept as a sidecar
  //    so a player or a re-edit can still use them)
  const srt = path.join(args.out, 'subtitles.srt');
  const srtBody = buildSrt(capture, timeline);
  fs.writeFileSync(srt, srtBody);
  const subtitleFilter = `subtitles=${escapeFilterPath(srt)}:force_style='${SUBTITLE_STYLE}'`;

  const master = path.join(args.out, args.name + '.mp4');
  run(FFMPEG, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', framesList, '-i', fullAudio,
    '-vf', subtitleFilter,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(args.crf), '-pix_fmt', 'yuv420p',
    '-r', String(args.fps), '-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-shortest',
    '-movflags', '+faststart', master]);

  const failed = verify(args, capture, master);
  return failed;
}

function verify(args, capture, master) {
  // 4. verify
  const checks = [];
  const streams = probe(master, ['-show_entries', 'stream=codec_name,width,height,pix_fmt,r_frame_rate']);
  const format = probe(master, ['-show_entries', 'format=duration,size']);
  const durationSec = parseFloat((format.match(/duration=([\d.]+)/) || [])[1] || '0');
  const sizeBytes = Number((format.match(/size=(\d+)/) || [])[1] || 0);

  let decodeOk = true;
  try { run(FFMPEG, ['-v', 'error', '-i', master, '-f', 'null', '-']); } catch (error) { decodeOk = false; }

  // volumedetect reports on stderr, so read stderr rather than the exit status.
  const meanAt = (t) => {
    const result = spawnSync(FFMPEG, ['-hide_banner', '-ss', String(t), '-t', '2',
      '-i', master, '-af', 'volumedetect', '-f', 'null', '/dev/null'], { encoding: 'utf8' });
    const m = String(result.stderr || '').match(/mean_volume:\s*(-?[\d.]+) dB/);
    return m ? Number(m[1]) : null;
  };

  const silent = [];
  for (const mark of capture.marks) {
    const at = Math.round(((mark.startMs + mark.endMs) / 2) / 1000);
    const mean = meanAt(at);
    if (mean === null || mean < -60) silent.push(at);
  }

  const stills = path.join(args.out, 'verify');
  fs.rmSync(stills, { recursive: true, force: true });
  fs.mkdirSync(stills, { recursive: true });
  const hashes = new Set();
  for (const mark of capture.marks) {
    const at = (mark.startMs + mark.endMs) / 2000;
    const file = path.join(stills, `scene-${mark.id}.png`);
    run(FFMPEG, ['-y', '-v', 'error', '-ss', at.toFixed(2), '-i', master, '-frames:v', '1', file]);
    hashes.add(require('node:crypto').createHash('md5').update(fs.readFileSync(file)).digest('hex'));
  }

  const srtPath = path.join(args.out, 'subtitles.srt');
  const subtitleFilter = `subtitles=${escapeFilterPath(srtPath)}:force_style='${SUBTITLE_STYLE}'`;
  const srtText = fs.existsSync(srtPath) ? fs.readFileSync(srtPath, 'utf8') : '';
  const cues = srtText.trim().split(/\n\n+/).filter(Boolean);
  const cueTimes = cues.map((c) => {
    const m = c.match(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/);
    return m ? { start: m[1], end: m[2] } : null;
  });
  const srtWellFormed = cues.length === capture.marks.length &&
    cueTimes.every((t) => t) &&
    cues.every((c) => c.split('\n').length >= 3 && c.split('\n')[2].trim().length > 10);

  // Prove libass can render the chosen style and font, so "subtitles are burned
  // in" is a measured fact rather than an assumption about the filter list.
  const probePng = path.join(args.out, 'verify', 'subtitle-render.png');
  let subtitleRenderable = false;
  let subtitleInk = null;
  try {
    run(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1280x720:d=1',
      '-vf', subtitleFilter, '-frames:v', '1', probePng]);
    const stats = spawnSync(FFMPEG, ['-hide_banner', '-i', probePng, '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YMAX',
      '-f', 'null', '-'], { encoding: 'utf8' });
    const m = String(stats.stderr || '').match(/YMAX=([\d.]+)/);
    subtitleInk = m ? Number(m[1]) : null;
    subtitleRenderable = subtitleInk !== null && subtitleInk > 100;
  } catch (error) {
    subtitleRenderable = false;
    console.warn('subtitle probe failed: ' + String((error && (error.stderr || error.message)) || error).slice(0, 400));
  }

  checks.push(['decodes without errors', decodeOk]);
  checks.push(['subtitles written and well formed', srtWellFormed]);
  checks.push(['subtitles render (libass + font)', subtitleRenderable]);
  checks.push(['video is h264 yuv420p', /codec_name=h264/.test(streams) && /pix_fmt=yuv420p/.test(streams)]);
  checks.push(['audio stream present (aac)', /codec_name=aac/.test(streams)]);
  checks.push(['duration within 2s of the plan', Math.abs(durationSec - capture.totalMs / 1000) < 2]);
  checks.push(['narration present in every scene', silent.length === 0]);
  checks.push(['every scene is visually distinct', hashes.size === capture.marks.length]);

  console.log('\n' + path.basename(master) + '  ' + (sizeBytes / 1048576).toFixed(2) + ' MB  ' +
    durationSec.toFixed(2) + 's  ' + streams.replace(/\n/g, ' '));
  for (const [label, ok] of checks) console.log((ok ? '  PASS  ' : '  FAIL  ') + label);
  if (silent.length) console.log('  silent scenes at: ' + silent.join(', ') + 's');

  const disclosure = capture.disclosure ? 'YES (simulated data)' : 'no';
  console.log('  recording mode: ' + capture.mode + ', disclosure badge: ' + disclosure);

  // 5. share copies (never overwrite public/video)
  if (args.share) {
    const shareDir = path.join(args.out, 'share');
    fs.mkdirSync(shareDir, { recursive: true });
    const variants = [
      ['whatsapp', ['-crf', '24', '-b:a', '96k', '-movflags', '+faststart']],
      ['telegram', ['-crf', '23', '-b:a', '96k', '-movflags', '+faststart']]
    ];
    for (const [label, extra] of variants) {
      const target = path.join(shareDir, args.name + '-' + label + '.mp4');
      run(FFMPEG, ['-y', '-v', 'error', '-i', master, '-c:v', 'libx264', '-preset', 'slow',
        '-profile:v', 'high', '-level', '4.0', '-pix_fmt', 'yuv420p', '-r', String(args.fps),
        ...extra, '-c:a', 'aac', '-ar', '48000', '-ac', '1', '-shortest', target]);
      const bytes = fs.statSync(target).size;
      console.log('  wrote ' + path.relative(ROOT, target) + '  ' + (bytes / 1048576).toFixed(2) + ' MB');
    }

    // Ready-to-paste caption. No profit or return claims: the video explains a
    // deposit, it does not sell an outcome.
    const caption = [
      'How to fund your Arbitrix Live balance',
      '',
      'A 90-second walkthrough: Demo Mode, switching to Live, and the deposit step -',
      'the amount, the TRON (TRC20) address, the QR code and the confirmation.',
      '',
      'Minimum deposit: $100. Send USDT on TRON (TRC20) only.',
      '',
      'Start here: https://arbitrix.pro/?action=create-account',
      'How it works: https://arbitrix.pro/how-it-works',
      'Support: https://t.me/ArbitrixSupportBot',
      '',
      'Trading involves risk. Nothing here is financial advice.'
    ].join('\n');
    fs.writeFileSync(path.join(shareDir, 'caption.txt'), caption + '\n');
    fs.copyFileSync(srtPath, path.join(shareDir, 'subtitles.srt'));
    console.log('  wrote ' + path.relative(ROOT, path.join(shareDir, 'caption.txt')));
  }

  const failed = checks.filter(([, ok]) => !ok).length;
  return failed === 0 ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  console.error('build failed:', error && error.message ? error.message : error);
  process.exit(1);
}
