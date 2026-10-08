'use strict';

/**
 * /how-it-works VIDEO tests.
 *
 * The page's explainer was replaced with the approved polished product demo.
 * Pinned here:
 *   - the page embeds the NEW asset and the NEW poster, and nothing else;
 *   - the retired explainer, its poster and the HeyGen CDN fallback are gone
 *     from the page (the CDN copy was the old AI-presenter video, so keeping it
 *     would have let the page play the retired video again);
 *   - the served MP4 is a byte-identical copy of the approved master (no
 *     re-encode: keep the final quality unchanged);
 *   - the poster is a real 1080x1920 frame from the new video;
 *   - the player contract is preserved: controls, playsinline, preload, muted
 *     autoplay only (never autoplay with sound), 9:16 responsive framing;
 *   - the LANDING page has since been repointed to the same new asset/poster;
 *     the retired explainer files are kept on disk but no longer referenced.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'how-it-works.html'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

const VIDEO_REL = path.join('public', 'video', 'arbitrix-how-it-works-product-demo-en.mp4');
const POSTER_REL = path.join('public', 'video', 'arbitrix-how-it-works-poster.jpg');
const MASTER_REL = path.join('build', 'video', 'how-it-works', 'arbitrix-how-it-works-product-demo-en.mp4');

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ---------------------------------------------------------------------------
// 1. the new video is embedded
// ---------------------------------------------------------------------------
test('the page embeds the approved product demo and its poster', () => {
    assert.match(PAGE,
        /<video[^>]*id="explainerVideo"[^>]*poster="\/video\/arbitrix-how-it-works-poster\.jpg"/,
        'explainer video element points at the new poster');
    assert.match(PAGE,
        /<source src="\/video\/arbitrix-how-it-works-product-demo-en\.mp4" type="video\/mp4">/,
        'single local source is the new asset');
    assert.ok(fs.existsSync(path.join(ROOT, VIDEO_REL)), 'new video asset exists');
    assert.ok(fs.existsSync(path.join(ROOT, POSTER_REL)), 'new poster asset exists');
});

test('the retired explainer, its poster and the CDN fallback are gone', () => {
    assert.ok(!PAGE.includes('arbitrix-explainer.mp4'), 'old video not referenced');
    assert.ok(!PAGE.includes('arbitrix-poster.jpg'), 'old poster not referenced');
    assert.ok(!/heygen\.ai/i.test(PAGE), 'no external CDN fallback (it served the retired video)');
    assert.ok(!/lastSourceIndex|currentSrc/.test(PAGE), 'no leftover fallback state');
    // exactly one source element: nothing can silently play the old file
    const sources = PAGE.match(/<source\b[^>]*>/g) || [];
    assert.strictEqual(sources.length, 1, 'exactly one <source> in the page');
});

// ---------------------------------------------------------------------------
// 2. the asset is the approved master, unmodified
// ---------------------------------------------------------------------------
test('the served MP4 is a byte-identical copy of the approved master (no re-encode)', () => {
    assert.ok(fs.existsSync(path.join(ROOT, MASTER_REL)), 'approved master is present for comparison');
    const served = fs.readFileSync(path.join(ROOT, VIDEO_REL));
    const master = fs.readFileSync(path.join(ROOT, MASTER_REL));
    assert.strictEqual(sha256(path.join(ROOT, VIDEO_REL)), sha256(path.join(ROOT, MASTER_REL)),
        'served bytes equal the approved master');
    assert.strictEqual(served.length, master.length, 'no re-encode (same size)');
    // ISO base media file format + ftyp box, i.e. a real MP4 container
    assert.strictEqual(served.slice(4, 8).toString('ascii'), 'ftyp', 'valid MP4 container');
});

test('the served MP4 is 1080x1920 (9:16) h264 with an audio track', () => {
    const buf = fs.readFileSync(path.join(ROOT, VIDEO_REL));
    assert.ok(buf.indexOf('avc1') > 0, 'h264 video track present');
    assert.ok(buf.indexOf('mp4a') > 0, 'aac audio track present');
    // the first tkhd box is the video track; its last 8 bytes are width/height
    // as 16.16 fixed point values
    const tkhd = buf.indexOf('tkhd');
    assert.ok(tkhd > 4, 'tkhd box present');
    const boxSize = buf.readUInt32BE(tkhd - 4);
    const w = buf.readUInt32BE(tkhd + boxSize - 12) / 65536;
    const h = buf.readUInt32BE(tkhd + boxSize - 8) / 65536;
    assert.strictEqual(w, 1080, 'video width');
    assert.strictEqual(h, 1920, 'video height');
});

test('the poster is a real 1080x1920 frame taken from the new video', () => {
    const jpg = fs.readFileSync(path.join(ROOT, POSTER_REL));
    assert.strictEqual(jpg[0], 0xFF, 'JPEG SOI');
    assert.strictEqual(jpg[1], 0xD8, 'JPEG SOI');
    assert.ok(jpg.length > 20000 && jpg.length < 400000, 'sane poster size: ' + jpg.length);
    // SOF0/SOF2 marker carries the frame dimensions
    let w = 0, h = 0;
    for (let i = 2; i < jpg.length - 9; i += 1) {
        if (jpg[i] === 0xFF && (jpg[i + 1] === 0xC0 || jpg[i + 1] === 0xC2)) {
            h = jpg.readUInt16BE(i + 5);
            w = jpg.readUInt16BE(i + 7);
            break;
        }
    }
    assert.strictEqual(w, 1080, 'poster width');
    assert.strictEqual(h, 1920, 'poster height');
});

// ---------------------------------------------------------------------------
// 3. player behaviour preserved
// ---------------------------------------------------------------------------
test('the player contract is preserved (controls, playsinline, responsive 9:16)', () => {
    assert.match(PAGE, /<video[^>]*controls[^>]*>/, 'native controls');
    assert.match(PAGE, /<video[^>]*playsinline[^>]*>/, 'playsinline for iOS Safari');
    assert.match(PAGE, /<video[^>]*preload="metadata"[^>]*>/, 'preload unchanged');
    assert.match(PAGE, /aspect-ratio:\s*9\s*\/\s*16/, 'portrait framing preserved');
    assert.match(PAGE, /object-fit:\s*contain/, 'video cannot be cropped or distorted');
    assert.match(PAGE, /@media \(min-width: 560px\)/, 'desktop rule preserved');
    assert.ok(!/<video[^>]*\bautoplay\b/.test(PAGE), 'no autoplay attribute');
    assert.match(PAGE, /v\.muted = true;/, 'starts muted (never autoplay with sound)');
    assert.match(PAGE, /v\.playsInline = true;/, 'playsInline set on the element too');
    assert.match(PAGE, /Your browser does not support embedded video\./, 'fallback text kept');
});

test('the page structure, CTAs and copy are untouched', () => {
    assert.match(PAGE, /id="explainerVideo"/, 'player id unchanged (no JS breakage)');
    assert.match(PAGE, /<h1>How Arbitrix Works<\/h1>/, 'heading kept');
    assert.match(PAGE, /href="\/\?action=create-account" id="createAccountCta"/, 'signup CTA kept');
    assert.match(PAGE, /href="\/\?action=sign-in" id="signInCta"/, 'sign-in CTA kept');
    assert.match(PAGE, /arbi_auth_entry/, 'existing auth entry contract kept');
    assert.match(PAGE, /class="video-wrap"/, 'layout wrapper kept');
    assert.match(PAGE, /class="video-frame"/, 'frame kept');
    assert.ok(!/landing-video|landing-section/.test(PAGE), 'no landing markup leaked into the page');
});

// ---------------------------------------------------------------------------
// 4. the landing page was repointed to the new assets (old files kept on disk)
// ---------------------------------------------------------------------------
test('the landing page now uses the new product demo and poster', () => {
    assert.match(INDEX, /class="landing-video"[^>]*poster="\/video\/arbitrix-how-it-works-poster\.jpg"/,
        'landing video uses the new poster');
    assert.match(INDEX, /<source src="\/video\/arbitrix-how-it-works-product-demo-en\.mp4" type="video\/mp4">/,
        'landing video source is the new asset');
    assert.ok(!INDEX.includes('arbitrix-explainer.mp4'),
        'the retired explainer is no longer referenced by the landing page');
    assert.ok(!INDEX.includes('arbitrix-poster.jpg'),
        'the retired poster is no longer referenced by the landing page');
    // The retired files must remain on disk (never overwritten or deleted).
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'video', 'arbitrix-explainer.mp4')),
        'old explainer asset kept on disk');
    assert.ok(fs.existsSync(path.join(ROOT, 'public', 'video', 'arbitrix-poster.jpg')),
        'old poster kept on disk');
});

test('exactly the landing and how-it-works pages reference the new video', () => {
    const walk = (dir, out = []) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name === 'build') continue;
            const p = path.join(dir, e.name);
            if (e.isDirectory()) walk(p, out);
            else if (/\.(html|js|json)$/.test(e.name)) out.push(p);
        }
        return out;
    };
    const refs = walk(path.join(ROOT, 'public')).filter((p) =>
        fs.readFileSync(p, 'utf8').includes('arbitrix-how-it-works-product-demo-en.mp4'));
    assert.deepStrictEqual(refs.map((p) => path.relative(ROOT, p)).sort(),
        ['public/how-it-works.html', 'public/index.html'],
        'exactly the two expected pages reference the new video');
});
