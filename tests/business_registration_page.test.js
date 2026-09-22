'use strict';

/**
 * BUSINESS REGISTRATION PAGE tests.
 *
 * A static, customer-facing trust page at /business-registration showing the
 * company's KVK (Netherlands Chamber of Commerce) registration details and the
 * uploaded certificate. Scope guards pinned here:
 *   - the exact legal name and KVK number come from the certificate (no guessing);
 *   - the certificate bytes are served UNMODIFIED (sha256 pinned);
 *   - no licence / regulatory-authorization claim, and no CAC/Nigeria reference;
 *   - no instructions telling customers how to verify the company, and no
 *     external verification links;
 *   - no unnecessary personal information transcribed from the certificate;
 *   - the Create Account / Sign In buttons reuse the EXISTING ?action= deep-link
 *     contract (no new authentication system);
 *   - the footer links to the page in all 6 locales.
 *
 * Static source checks only: no network, no database, no server boot.
 *
 * Run: npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const PAGE_PATH = path.join(ROOT, 'public', 'business-registration.html');
const PAGE = fs.readFileSync(PAGE_PATH, 'utf8');
const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

const CERT_REL = '/certificates/kvk-business-registration-page-1.jpg';
const CERT_PATH = path.join(ROOT, 'public', CERT_REL.replace(/^\//, ''));
// The published certificate is a byte-identical copy of the uploaded KVK
// extract page 1 (refresh 2026-09-22: same document, cleaner capture).
const CERT_SHA256 = '3497d5873c9837c1af30c1370763953dc8ea94291f470171048f9e7dce52243e';

// Values extracted from the KVK Business Register extract (page 1).
const LEGAL_NAME = 'Arbitrix Trading';
const KVK_NUMBER = '72923513';

function loadTranslations() {
    const tIdx = INDEX.indexOf('const TRANSLATIONS');
    let i = INDEX.indexOf('{', tIdx), depth = 0, end = -1;
    for (; i < INDEX.length; i++) {
        if (INDEX[i] === '{') depth++;
        else if (INDEX[i] === '}') { depth--; if (!depth) { end = i; break; } }
    }
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(INDEX.slice(tIdx, end + 1) + ';globalThis.__T = TRANSLATIONS;', sandbox);
    return sandbox.__T;
}

const T = loadTranslations();

/** Anchor hrefs only (font/CDN <link> tags are not customer-facing links). */
function anchorHrefs(html) {
    const out = [];
    const re = /<a\b[^>]*\bhref\s*=\s*"([^"]*)"/gi;
    let m;
    while ((m = re.exec(html)) !== null) out.push(m[1]);
    return out;
}

/* ------------------------------------------------------------------ *
 * 1. Page + route exist
 * ------------------------------------------------------------------ */
test('1. the page exists and /business-registration is routed to it', () => {
    assert.ok(fs.existsSync(PAGE_PATH), 'public/business-registration.html must exist');
    assert.match(SERVER, /app\.get\(\[[^\]]*'\/business-registration'[^\]]*\][\s\S]{0,120}business-registration\.html/,
        'server.js must serve the page at /business-registration');
    assert.match(SERVER, /'\/business-registration\/'/, 'the trailing-slash form must be routed too');
    // Static middleware still serves public/ so the certificate asset is reachable.
    assert.match(SERVER, /express\.static\(path\.join\(__dirname,\s*'public'\)\)/);
});

test('1b. the page is complete, self-contained HTML with the requested title', () => {
    assert.match(PAGE, /^<!DOCTYPE html>/i);
    assert.match(PAGE, /<html lang="en">/);
    assert.match(PAGE, /<title>Arbitrix Business Registration - Arbitrix AI<\/title>/);
    assert.match(PAGE, /<h1[^>]*>\s*Arbitrix Business Registration\s*<\/h1>/);
    assert.ok(PAGE.trim().endsWith('</html>'), 'the document must be complete');
    // Static content: no server data, no auth calls, no credential collection.
    assert.ok(!/\/api\//.test(PAGE), 'the page must not call any API');
    assert.ok(!/<form\b/i.test(PAGE), 'the page must not contain a form');
    assert.ok(!/type\s*=\s*"password"/i.test(PAGE), 'the page must not ask for a password');
});

/* ------------------------------------------------------------------ *
 * 2/3. Exact legal name + KVK number
 * ------------------------------------------------------------------ */
test('2. the exact legal company name appears verbatim', () => {
    assert.ok(PAGE.includes(LEGAL_NAME), 'the legal name must appear');
    assert.ok(
        PAGE.includes('Arbitrix is operated by ' + LEGAL_NAME + ', registered with the Netherlands Chamber of Commerce (KVK).'),
        'the requested wording must appear verbatim'
    );
});

test('3. the exact KVK number appears', () => {
    assert.ok(PAGE.includes(KVK_NUMBER), 'the KVK number must appear');
    assert.match(PAGE, /KVK Number:/, 'the number must be labelled "KVK Number:"');
    const labelAt = PAGE.indexOf('KVK Number:');
    assert.ok(PAGE.slice(labelAt, labelAt + 400).includes(KVK_NUMBER), 'the KVK label must be followed by the number');
    // Any 8-digit run on the page must BE the KVK number (no invented/typo number).
    (PAGE.match(/\b\d{8}\b/g) || []).forEach((n) => {
        assert.strictEqual(n, KVK_NUMBER, 'unexpected 8-digit number on the page: ' + n);
    });
});

/* ------------------------------------------------------------------ *
 * 4. Certificate is served and displayed
 * ------------------------------------------------------------------ */
test('4. the certificate asset is served, is a real JPEG, and is UNMODIFIED', () => {
    assert.ok(fs.existsSync(CERT_PATH), 'the certificate asset must exist in public/');

    const buf = fs.readFileSync(CERT_PATH);
    assert.ok(buf.length > 10000, 'the certificate must be a real image, got ' + buf.length + ' bytes');
    assert.deepStrictEqual([buf[0], buf[1], buf[2]], [0xFF, 0xD8, 0xFF], 'the asset must be a JPEG');

    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    assert.strictEqual(sha, CERT_SHA256, 'the certificate bytes must be the uploaded original (unmodified)');
});

test('4b. the page displays the certificate and offers a larger view', () => {
    assert.match(PAGE, /<img[\s\S]{0,200}src="\/certificates\/kvk-business-registration-page-1\.jpg"/,
        'the certificate image must be embedded');
    assert.match(PAGE, /alt="KVK Business Register extract for Arbitrix Trading, KVK number 72923513"/,
        'the certificate must carry descriptive alt text');
    // Click-to-enlarge viewer + full-size / download affordances.
    assert.match(PAGE, /id="lightbox"/, 'a full-size viewer must exist');
    assert.match(PAGE, /id="certOpen"/, 'the certificate must be openable');
    assert.match(PAGE, /id="certNewTab"[\s\S]{0,200}target="_blank"/, 'a full-size link must exist');
    assert.match(PAGE, /id="lightboxImage"/, 'the viewer must contain the certificate');
    // The displayed image must not be cropped/letterboxed by CSS.
    assert.match(PAGE, /\.cert-frame img\s*\{[^}]*width:\s*100%[^}]*height:\s*auto/);
});

/* ------------------------------------------------------------------ *
 * 5/6. Account buttons reuse the EXISTING auth deep links
 * ------------------------------------------------------------------ */
test('5. the Create Account button uses the existing ?action=create-account deep link', () => {
    assert.match(PAGE, /id="createAccountCta"[^>]*href="\/\?action=create-account"|href="\/\?action=create-account"[^>]*id="createAccountCta"/,
        'Create Account must use the existing deep link');
    assert.ok(PAGE.includes('>Create Account') || /Create Account/.test(PAGE));
    // The existing contract is handled by the app shell.
    assert.match(INDEX, /action=create-account/, 'the app shell must still handle the create-account action');
});

test('6. the Sign In button uses the existing ?action=sign-in deep link', () => {
    assert.match(PAGE, /id="signInCta"[^>]*href="\/\?action=sign-in"|href="\/\?action=sign-in"[^>]*id="signInCta"/,
        'Sign In must use the existing deep link');
    assert.match(INDEX, /action=sign-in/, 'the app shell must still handle the sign-in action');
});

test('6b. no new authentication system is introduced', () => {
    // Only the two documented auth entry points, both same-origin query links.
    const hrefs = anchorHrefs(PAGE);
    const authLinks = hrefs.filter((h) => h.includes('action='));
    assert.ok(authLinks.length >= 2);
    authLinks.forEach((h) => assert.ok(h === '/?action=create-account' || h === '/?action=sign-in', 'unexpected auth link ' + h));
    assert.ok(!/signup\s*\(|login\s*\(|fetch\(|\/api\/auth/i.test(PAGE), 'no bespoke auth logic on the page');
});

/* ------------------------------------------------------------------ *
 * 7. No licence / regulatory claims, no CAC/Nigeria, no verify instructions
 * ------------------------------------------------------------------ */
test('7. the KVK registration is never described as a licence or authorization', () => {
    const body = PAGE.toLowerCase();
    ['licence', 'license', 'licensed', 'regulatory', 'regulator', 'authorization', 'authorisation', 'authorized', 'authorised', 'financial authority', 'investment authority', 'supervised by', 'approved by'].forEach((word) => {
        assert.ok(!body.includes(word), 'the page must not claim: ' + word);
    });
});

test('7b. no CAC / Nigerian registration reference', () => {
    const body = PAGE.toLowerCase();
    ['cac', 'nigeria', 'nigerian', 'corporate affairs commission'].forEach((word) => {
        assert.ok(!body.includes(word), 'the page must not mention: ' + word);
    });
});

test('7c. no "how to verify" instructions and no external verification links', () => {
    assert.ok(!/kvk\.nl/i.test(PAGE), 'no external KVK link');
    const hrefs = anchorHrefs(PAGE);
    hrefs.forEach((h) => {
        assert.ok(!/^https?:\/\//i.test(h), 'external anchor must not exist: ' + h);
        assert.ok(h.startsWith('/') || h.startsWith('#') || h.startsWith('mailto:'), 'unexpected href: ' + h);
    });
    assert.ok(!/to verify|how to verify|check the register|search the register|look up our|verify our/i.test(PAGE),
        'no instructions telling customers how to verify the company');
});

test('7d. no unnecessary personal information is copied from the certificate', () => {
    // The certificate image itself contains the register extract, and is published
    // as-is on purpose. None of its extra personal details are transcribed here.
    ['Leenewald', '9407', '42083000', '000021127493', '5.000', 'SBI 74279', 'Eenmanszaak', 'Sole shareholder'].forEach((fragment) => {
        assert.ok(!PAGE.includes(fragment), 'must not publish: ' + fragment);
    });
    // Only the legally-identifying facts are stated.
    assert.ok(!/\b(?:BTW|RSIN|IBAN)\b/.test(PAGE), 'no tax / bank identifiers');
    assert.ok(!/\+31/.test(PAGE), 'no phone number');
});

test('7e. the page does not read like a government/regulator site', () => {
    const body = PAGE.toLowerCase();
    ['government', 'ministry', 'official register', 'certificate of incorporation', 'regulatory authority', '.gov'].forEach((word) => {
        assert.ok(!body.includes(word), 'must not look governmental: ' + word);
    });
});

/* ------------------------------------------------------------------ *
 * 8. Design: mobile-first, readable, clean
 * ------------------------------------------------------------------ */
test('8. the page is mobile-first and matches the Arbitrix palette', () => {
    assert.match(PAGE, /<meta name="viewport" content="width=device-width, initial-scale=1\.0">/);
    assert.match(PAGE, /--brand:\s*#F0B90B/);
    assert.match(PAGE, /--bg-primary:\s*#070B14/);
    assert.match(PAGE, /@media \(max-width: 640px\)/, 'a mobile breakpoint must exist');
    // The certificate is readable on mobile: full-width, and a scrollable viewer.
    assert.match(PAGE, /\.lightbox-scroll\s*\{[^}]*overflow:\s*auto/);
    // Touch targets.
    assert.match(PAGE, /min-height:\s*4[2-9]px/);
});

/* ------------------------------------------------------------------ *
 * 9. Landing footer link + i18n parity
 * ------------------------------------------------------------------ */
test('9. the landing footer links to the page from the Legal column', () => {
    assert.match(INDEX, /<a href="\/business-registration" data-i18n="landing\.footer\.businessRegistration">[\s\S]*?<\/a>/,
        'the footer must link to /business-registration');
    // Placed inside the Legal column next to the other legal links.
    const legalIdx = INDEX.indexOf('data-i18n="landing.footer.legal"');
    const linkIdx = INDEX.indexOf('href="/business-registration"');
    assert.ok(legalIdx >= 0 && linkIdx > legalIdx, 'the link must follow the Legal heading');
});

test('9b. the new i18n key exists in all six locales with no empty value', () => {
    assert.strictEqual(new Set(LANGS.map((l) => Object.keys(T[l]).sort().join('|'))).size, 1, 'identical key sets');
    LANGS.forEach((l) => {
        const value = T[l]['landing.footer.businessRegistration'];
        assert.ok(value && String(value).trim(), l + ' is missing landing.footer.businessRegistration');
    });
    assert.strictEqual(T.en['landing.footer.businessRegistration'], 'Business Registration');
});
