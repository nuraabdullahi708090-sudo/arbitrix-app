/**
 * OPERATING LICENSE VIEWER.
 *
 * Pins the additive feature end to end:
 *   1. the supplied document is stored byte-for-byte in a dedicated public asset
 *      directory and is served without authentication;
 *   2. /operating-license serves the dedicated viewer page (not the SPA shell)
 *      and the page renders the whole document, page after page, from a single
 *      declarative list;
 *   3. the viewer offers zoom + scrolling and NO download / save / export /
 *      print control and no embedded PDF toolbar;
 *   4. the "View Operating License" section exists below the dashboard content
 *      and on the public surfaces, and its copy is translated in all six locales;
 *   5. nothing in the money paths, the auth flow or the existing dashboard was
 *      touched by the feature.
 *
 * The viewer's real inline script is executed in a vm against a fake DOM, so the
 * behaviours below are observed, not merely pattern-matched.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const INDEX = read('public/index.html');
const PAGE = read('public/operating-license.html');
const SERVER = read('server.js');

const DOC_REL = 'license/kalderix-operating-license.jpg';
const DOC_PATH = path.join(ROOT, 'public', DOC_REL);
const DOC_URL = '/license/kalderix-operating-license.jpg';
const DOC = fs.readFileSync(DOC_PATH);

const LANGS = ['en', 'es', 'pt', 'fr', 'ar', 'zh'];

/* ------------------------------------------------------------------ *
 * helpers
 * ------------------------------------------------------------------ */

function jpegSize(buf) {
    let i = 2;
    while (i < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
        const length = buf.readUInt16BE(i + 2);
        if (marker >= 0xc0 && marker <= 0xc3) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + length;
    }
    return null;
}

/** Minimal DOM good enough for the viewer script (no jsdom in this repo). */
function makeDom(options) {
    options = options || {};
    const byId = new Map();
    const listeners = new Map();

    function el(tag) {
        const node = {
            tagName: tag.toUpperCase(),
            children: [],
            attributes: {},
            style: {},
            dataset: {},
            classes: new Set(),
            listeners: {},
            textContent: '',
            hidden: false,
            disabled: false,
            naturalWidth: 853,
            naturalHeight: 1280,
            clientWidth: 0,
            appended: [],
            setAttribute(name, value) { node.attributes[name] = String(value); },
            getAttribute(name) { return Object.prototype.hasOwnProperty.call(node.attributes, name) ? node.attributes[name] : null; },
            removeAttribute(name) { delete node.attributes[name]; },
            addEventListener(type, fn) { (node.listeners[type] = node.listeners[type] || []).push(fn); },
            removeEventListener() {},
            appendChild(child) { node.children.push(child); child.parentNode = node; node.appended.push(child); return child; },
            getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: node.offsetHeight || 0, width: 0, height: node.offsetHeight || 0 }; },
            querySelectorAll(sel) { return node.children.filter((c) => c.tagName === String(sel).toUpperCase()); },
            get className() { return Array.from(node.classes).join(' '); },
            set className(value) { node.classes = new Set(String(value).split(/\s+/).filter(Boolean)); },
            classList: {
                add: (c) => node.classes.add(c),
                remove: (c) => node.classes.delete(c),
                contains: (c) => node.classes.has(c),
                toggle: (c, on) => {
                    if (on === undefined) {
                        if (node.classes.has(c)) node.classes.delete(c); else node.classes.add(c);
                    } else if (on) node.classes.add(c); else node.classes.delete(c);
                }
            }
        };
        const srcStore = { value: '' };
        Object.defineProperty(node, 'src', {
            get() { return srcStore.value || node.attributes.src || ''; },
            set(value) { srcStore.value = String(value); node.attributes.src = String(value); }
        });
        ['alt', 'href', 'title'].forEach((name) => {
            const store = { value: '' };
            Object.defineProperty(node, name, {
                get() { return store.value || node.attributes[name] || ''; },
                set(value) { store.value = String(value); node.attributes[name] = String(value); }
            });
        });
        Object.defineProperty(node, 'innerHTML', {
            get() { return ''; },
            set(value) { if (value === '') { node.children.length = 0; node.appended.length = 0; } }
        });
        return node;
    }

    const ids = [
        'licStage', 'licPages', 'licLoading', 'licError', 'licRetry', 'licZoomValue',
        'licZoomIn', 'licZoomOut', 'licZoomFit', 'licZoomActual', 'licPageCount',
        'licPageCountFact', 'licBack'
    ];
    ids.forEach((id) => { const node = el(id === 'licStage' ? 'div' : 'button'); byId.set(id, node); });
    byId.get('licStage').clientWidth = options.stageWidth || 881;

    const documentElement = { style: { setProperty(k, v) { documentElement.style[k] = v; } } };
    const topbar = el('header');
    topbar.offsetHeight = 62;

    const historyCalls = [];
    const navCalls = [];

    const document = {
        referrer: options.referrer || '',
        getElementById: (id) => byId.get(id) || null,
        querySelector: (sel) => (sel === '.lic-topbar' ? topbar : null),
        createElement: (tag) => el(tag),
        documentElement,
        body: el('body')
    };

    const window = {
        history: { length: options.historyLength === undefined ? 2 : options.historyLength, back: () => historyCalls.push('back') },
        location: { origin: 'https://arbitrix.pro', assign: (u) => navCalls.push(u) },
        addEventListener: (type, fn) => { (listeners.get(type) || listeners.set(type, []).get(type)).push(fn); },
        clearTimeout: () => {},
        setTimeout: (fn) => { if (options.runTimers) fn(); return 1; }
    };

    return { byId, document, window, historyCalls, navCalls, el, listeners };
}

function viewerScript() {
    const match = PAGE.match(/<script>([\s\S]*?)<\/script>/);
    assert.ok(match, 'the viewer must ship one inline script');
    return match[1];
}

function runViewer(options) {
    const dom = makeDom(options);
    const sandbox = {
        document: dom.document,
        window: dom.window,
        location: dom.window.location,
        history: dom.window.history,
        URL: URL,
        console: { warn() {}, error() {}, log() {} },
        setTimeout: dom.window.setTimeout,
        clearTimeout: dom.window.clearTimeout
    };
    vm.runInNewContext(viewerScript(), sandbox, { filename: 'operating-license.html' });
    return dom;
}

function click(node) {
    (node.listeners.click || []).forEach((fn) => fn({ preventDefault() { node.defaultPrevented = true; }, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0 }));
}

/* ------------------------------------------------------------------ *
 * 1. the supplied document is stored verbatim
 * ------------------------------------------------------------------ */

test('1. the license document is a byte-identical copy of the supplied attachment', () => {
    assert.ok(fs.existsSync(DOC_PATH), 'the document must exist at public/' + DOC_REL);
    const sha = crypto.createHash('sha256').update(DOC).digest('hex');
    assert.strictEqual(sha, '1b2e559560d621e778289b7c2b1c32e41d3581446e84c3cdd04c21531f24b899',
        'the stored bytes must be the supplied document, unmodified');
    assert.strictEqual(DOC.length, 198153, 'and its exact size');
    assert.strictEqual(DOC.slice(0, 2).toString('hex'), 'ffd8', 'it is a JPEG as supplied');
});

test('2. the document is a single page of 853x1280, read from its own header', () => {
    const size = jpegSize(DOC);
    assert.deepStrictEqual(size, { width: 853, height: 1280 });
    // The viewer declares the same geometry so it can lay the page out before
    // the bytes arrive (no layout jump, no flash at the wrong scale).
    const declared = PAGE.match(/src: '([^']+)',\s*\n\s*width: (\d+),\s*\n\s*height: (\d+),/);
    assert.ok(declared, 'the page list must declare src/width/height');
    assert.strictEqual(declared[1], DOC_URL);
    assert.strictEqual(Number(declared[2]), size.width);
    assert.strictEqual(Number(declared[3]), size.height);
});

test('3. the document lives in its own public directory, not mixed with other assets', () => {
    const entries = fs.readdirSync(path.join(ROOT, 'public', 'license'));
    assert.deepStrictEqual(entries, ['kalderix-operating-license.jpg'],
        'the license directory carries the document only');
    // It must never be reachable through the private certificate folder.
    assert.ok(!DOC_REL.includes('certificates/'));
});

/* ------------------------------------------------------------------ *
 * 2. public, authentication-free delivery
 * ------------------------------------------------------------------ */

test('4. /operating-license is routed to the viewer page before the SPA fallback', () => {
    const route = SERVER.match(/app\.get\(\[[^\]]*'\/operating-license'[^\]]*\][\s\S]{0,160}?operating-license\.html/);
    assert.ok(route, 'the route must send the viewer page');
    assert.match(route[0], /'\/operating-license\/'/, 'the trailing-slash form must be routed too');
    const routeAt = SERVER.indexOf("'/operating-license'");
    const fallbackAt = SERVER.lastIndexOf('app.use((req, res) => {');
    assert.ok(routeAt > 0 && routeAt < fallbackAt, 'the route must precede the SPA fallback');
    // No gate in front of it.
    const before = SERVER.slice(SERVER.lastIndexOf('\napp.', routeAt), routeAt);
    assert.ok(!/authMiddleware|adminMiddleware/.test(before.slice(-200)),
        'the route must not require a session');
});

test('5. the missing-document path answers a real 404 instead of the SPA shell', () => {
    assert.match(SERVER, /app\.use\('\/license',[\s\S]{0,160}?status\(404\)\.json/,
        'a missing license asset must not fall through to index.html with HTTP 200');
});

test('6. the viewer reads no session, no storage and calls no API', () => {
    assert.ok(!/fetch\s*\(|XMLHttpRequest|EventSource|WebSocket/.test(PAGE), 'no network calls');
    assert.ok(!/localStorage|sessionStorage|document\.cookie|jwt_token|Authorization:\s*Bearer/.test(PAGE),
        'the page must not read any session state');
    assert.ok(!/\/api\//.test(PAGE), 'no API endpoints');
    assert.ok(!/arbi_|arbitrix-|ARBITRIX_/.test(PAGE), 'no app-internal configuration');
    // And the document itself is a plain static asset.
    assert.ok(!/app\.get\([^)]*kalderix-operating-license/.test(SERVER),
        'the document must be served by express.static, not a bespoke handler');
});

/* ------------------------------------------------------------------ *
 * 3. the viewer itself
 * ------------------------------------------------------------------ */

test('7. the page renders every declared page, in order', () => {
    const dom = runViewer({ stageWidth: 881 });
    const pagesEl = dom.byId.get('licPages');
    assert.strictEqual(pagesEl.children.length, 1, 'one figure for one page');
    const figure = pagesEl.children[0];
    assert.strictEqual(figure.tagName, 'FIGURE');
    const img = figure.children[0];
    assert.strictEqual(img.tagName, 'IMG');
    assert.strictEqual(img.getAttribute('src'), DOC_URL, 'the exact stored document is rendered');
    assert.match(img.getAttribute('alt'), /license/i, 'the image has a descriptive alt');
    assert.strictEqual(img.loading, 'eager', 'the first page loads immediately');
    assert.strictEqual(dom.byId.get('licPageCountFact').textContent, '1 page');
});

test('8. the page list is multipage-capable: two entries render two figures with captions', () => {
    const source = viewerScript();
    // The render loop is driven by PAGES, not by a single hard-coded image.
    assert.match(source, /PAGES\.forEach\(function \(page, index\)/, 'the renderer iterates the page list');
    assert.match(source, /caption\.textContent = 'Page ' \+ \(index \+ 1\) \+ ' of ' \+ PAGES\.length/,
        'each page is captioned in order');
    assert.match(source, /PAGES\.length > 1/, 'captions appear for multipage documents');

    // Prove it by executing the same renderer with two pages.
    const twoPages = source.replace(
        /var PAGES = \[[\s\S]*?\n        \];/,
        "var PAGES = [{ src: '/license/kalderix-operating-license.jpg', width: 853, height: 1280, alt: 'Page one' },\n" +
        "                     { src: '/license/kalderix-operating-license.jpg', width: 853, height: 1280, alt: 'Page two' }];"
    );
    assert.notStrictEqual(twoPages, source, 'the page list must be replaceable for the check');

    const dom = makeDom({ stageWidth: 881 });
    vm.runInNewContext(twoPages, {
        document: dom.document, window: dom.window, location: dom.window.location,
        history: dom.window.history, URL: URL, console: { warn() {} },
        setTimeout: dom.window.setTimeout, clearTimeout: dom.window.clearTimeout
    }, { filename: 'two-pages' });

    const figures = dom.byId.get('licPages').children;
    assert.strictEqual(figures.length, 2, 'both pages are rendered');
    assert.deepStrictEqual(figures.map((f) => f.children[0].getAttribute('alt')), ['Page one', 'Page two'],
        'in declaration order');
    figures.forEach((f, i) => {
        assert.strictEqual(f.children[1].textContent, 'Page ' + (i + 1) + ' of 2');
    });
    assert.strictEqual(dom.byId.get('licPageCountFact').textContent, '2 pages');
});

test('9. zoom in, zoom out, fit width and 100% all act on the rendered page', () => {
    // Stage 881px wide leaves 853px of content: fit = 100%.
    const dom = runViewer({ stageWidth: 881 });
    const img = dom.byId.get('licPages').children[0].children[0];
    assert.strictEqual(img.style.width, '853px', 'fit width at a wide stage is 1:1');

    click(dom.byId.get('licZoomIn'));
    assert.strictEqual(img.style.width, Math.round(853 * 1.15) + 'px', 'zoom in scales the page up');
    assert.strictEqual(dom.byId.get('licZoomValue').textContent, '115%');

    click(dom.byId.get('licZoomOut'));
    click(dom.byId.get('licZoomOut'));
    assert.strictEqual(img.style.width, Math.round(853 * 0.85) + 'px', 'zoom out scales it down');

    click(dom.byId.get('licZoomActual'));
    assert.strictEqual(img.style.width, '853px', '100% is the native size');
    assert.strictEqual(dom.byId.get('licZoomActual').getAttribute('aria-pressed'), 'true');

    // A narrower stage (a phone) fits the page to the width instead of overflowing.
    const phone = runViewer({ stageWidth: 380 });
    const phoneImg = phone.byId.get('licPages').children[0].children[0];
    const expected = Math.round(853 * ((380 - 28) / 853));
    assert.strictEqual(phoneImg.style.width, expected + 'px', 'fit width shrinks the page on a phone');
    assert.strictEqual(phone.byId.get('licZoomFit').getAttribute('aria-pressed'), 'true');
});

test('10. zoom is clamped and the buttons disable at the limits', () => {
    const dom = runViewer({ stageWidth: 881 });
    const img = dom.byId.get('licPages').children[0].children[0];
    for (let i = 0; i < 40; i += 1) click(dom.byId.get('licZoomIn'));
    assert.strictEqual(img.style.width, Math.round(853 * 4) + 'px', 'never past 400%');
    assert.strictEqual(dom.byId.get('licZoomIn').disabled, true, 'zoom-in disables at the ceiling');

    for (let i = 0; i < 60; i += 1) click(dom.byId.get('licZoomOut'));
    assert.strictEqual(img.style.width, Math.round(853 * 0.25) + 'px', 'never below 25%');
    assert.strictEqual(dom.byId.get('licZoomOut').disabled, true, 'zoom-out disables at the floor');
});

test('11. keyboard and ctrl-wheel shortcuts zoom without breaking normal scrolling', () => {
    const dom = runViewer({ stageWidth: 881 });
    const stage = dom.byId.get('licStage');
    const img = dom.byId.get('licPages').children[0].children[0];

    const keydown = stage.listeners.keydown[0];
    let prevented = 0;
    keydown({ key: '+', preventDefault: () => { prevented += 1; } });
    assert.strictEqual(img.style.width, Math.round(853 * 1.15) + 'px');
    keydown({ key: '0', preventDefault: () => { prevented += 1; } });
    assert.strictEqual(img.style.width, '853px', '0 restores fit width');
    keydown({ key: '1', preventDefault: () => { prevented += 1; } });
    assert.strictEqual(img.style.width, '853px', '1 is 100%');
    assert.ok(prevented >= 3, 'the handled keys do not also scroll the page');

    const wheel = stage.listeners.wheel[0];
    let wheelPrevented = 0;
    wheel({ deltaY: -100, ctrlKey: false, metaKey: false, preventDefault: () => { wheelPrevented += 1; } });
    assert.strictEqual(wheelPrevented, 0, 'a plain wheel keeps scrolling the document');
    wheel({ deltaY: -100, ctrlKey: true, preventDefault: () => { wheelPrevented += 1; } });
    assert.strictEqual(wheelPrevented, 1, 'ctrl+wheel zooms and is consumed');
});

test('11b. the reading toolbar sticks under the top bar and a zoomed page stays start-aligned', () => {
    const css = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
    // `overflow:hidden` on the viewer shell would become the sticky containing
    // block and silently turn the toolbar into a static element.
    const viewerRule = css.slice(css.indexOf('.lic-viewer {'), css.indexOf('.lic-toolbar {'));
    assert.match(viewerRule, /overflow: clip/, 'the shell must clip, not hide, the overflow');
    assert.ok(!/overflow: hidden/.test(viewerRule), 'overflow:hidden would kill the sticky toolbar');

    assert.match(css, /\.lic-toolbar \{\s*position: sticky; top: var\(--lic-topbar-h, 64px\)/,
        'the toolbar sticks directly beneath the measured top bar');
    assert.match(PAGE, /setProperty\('--lic-topbar-h'/, 'the offset is measured at runtime');
    assert.match(PAGE, /addEventListener\('load', syncTopbarHeight\)/, 'and re-measured after load');

    // A flex-centred page that is wider than the stage overflows to a NEGATIVE
    // offset, so its left edge can never be scrolled to. max-content + min-width
    // keeps the start edge reachable.
    const pagesRule = css.slice(css.indexOf('.lic-pages {'), css.indexOf('.lic-page {'));
    assert.match(pagesRule, /width: max-content/);
    assert.match(pagesRule, /min-width: 100%/);
    assert.match(pagesRule, /margin-inline: auto/);
});

test('12. the document area scrolls and pinch-zoom is not disabled', () => {
    const css = PAGE.slice(PAGE.indexOf('<style>'), PAGE.indexOf('</style>'));
    const stageRule = css.slice(css.indexOf('.lic-stage {'), css.indexOf('.lic-pages {'));
    assert.match(stageRule, /overflow: auto/, 'the stage is a scrolling region');
    assert.ok(!/touch-action:\s*none/.test(css), 'pinch-zoom must stay available on phones');
    assert.ok(!/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/.test(PAGE), 'the viewport must allow zooming');
    assert.match(stageRule, /overscroll-behavior: contain/);
    // Both phone and desktop keep a usable document height.
    assert.match(css, /max-height: min\(78vh, 1180px\)/);
    assert.match(css, /@media \(max-width: 640px\)[\s\S]{0,400}?\.lic-stage \{ max-height: none; padding: 10px; \}/,
        'phones scroll the document with the page instead of a cramped slice');
});

/* ------------------------------------------------------------------ *
 * 4. viewing restrictions
 * ------------------------------------------------------------------ */

test('13. no download, save, export or print control is presented', () => {
    assert.ok(!/<a\b[^>]*\bdownload\b/i.test(PAGE), 'no download attribute');
    assert.ok(!/window\.print|\.print\(\)/i.test(PAGE), 'no print call');
    assert.ok(!/>\s*(download|save|export|print)\b/i.test(PAGE), 'no control labelled download/save/export/print');
    assert.ok(!/fa-(download|print|floppy-disk|file-export|share-from-square)\b/i.test(PAGE),
        'no download/print/export icons');
    assert.ok(!/target="_blank"/.test(PAGE), 'the document is never handed to another tab');
    assert.ok(!/href="\/license\//.test(PAGE), 'the raw document is not linked');
});

test('14. no browser-default PDF viewer or embedded PDF object is used', () => {
    assert.ok(!/<embed|<object|<iframe/i.test(PAGE), 'no embedded browser plugin surface');
    assert.ok(!/application\/pdf|\.pdf['"]/i.test(PAGE), 'no PDF object to host a default toolbar');
    assert.ok(!/toolbar\s*=\s*0|#zoom=/i.test(PAGE), 'no PDF chrome query parameters');
    // The document is an image, which a browser shows without any chrome.
    assert.match(PAGE, /<img src="\/license\/kalderix-operating-license\.jpg"/,
        'the noscript fallback is the same image');
    assert.match(PAGE, /img\.draggable = false/);
});

test('15. the page states what the viewer does not offer, without over-claiming', () => {
    assert.match(PAGE, /This viewer does not include download, save, export or print controls\./);
    // It must not claim that copying or screenshots are impossible.
    assert.ok(!/cannot be (copied|screenshotted|downloaded)|prevents? (copying|screenshots)|copy[- ]protected/i.test(PAGE),
        'no copy-protection claim');
});

/* ------------------------------------------------------------------ *
 * 5. loading, errors and back navigation
 * ------------------------------------------------------------------ */

test('16. a failed load shows an actionable error and a retry re-renders', () => {
    const dom = runViewer({ stageWidth: 881 });
    const img = dom.byId.get('licPages').children[0].children[0];
    dom.byId.get('licLoading').hidden = false;

    img.listeners.error.forEach((fn) => fn());
    assert.strictEqual(dom.byId.get('licError').hidden, false, 'the error panel is revealed');
    assert.strictEqual(dom.byId.get('licLoading').hidden, true, 'the spinner is removed');

    click(dom.byId.get('licRetry'));
    assert.strictEqual(dom.byId.get('licError').hidden, true, 'retry clears the error');
    const figures = dom.byId.get('licPages').children;
    assert.strictEqual(figures.length, 1, 'the page list is rebuilt');
    assert.strictEqual(figures[0].children[0].getAttribute('src'), DOC_URL);
});

test('17. a successful load hides the spinner and keeps the fitted scale', () => {
    const dom = runViewer({ stageWidth: 380 });
    const img = dom.byId.get('licPages').children[0].children[0];
    img.listeners.load.forEach((fn) => fn());
    assert.strictEqual(dom.byId.get('licLoading').hidden, true);
    assert.strictEqual(img.style.width, Math.round(853 * ((380 - 28) / 853)) + 'px');
});

test('18. Back returns to the previous page when it came from the app, and to / otherwise', () => {
    // Same-origin referrer: history.back() so the dashboard view and session survive.
    const fromApp = runViewer({ stageWidth: 881, referrer: 'https://arbitrix.pro/', historyLength: 4 });
    const backBtn = fromApp.byId.get('licBack');
    const event = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    backBtn.listeners.click.forEach((fn) => fn(event));
    assert.strictEqual(event.defaultPrevented, true, 'the navigation is intercepted');
    assert.deepStrictEqual(fromApp.historyCalls, ['back'], 'browser history is used');

    // Direct visit / new tab: keep the plain href so "/" is the destination.
    const direct = runViewer({ stageWidth: 881, referrer: '', historyLength: 1 });
    const directEvent = { metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    direct.byId.get('licBack').listeners.click.forEach((fn) => fn(directEvent));
    assert.strictEqual(directEvent.defaultPrevented, false, 'the link behaves normally');
    assert.match(PAGE, /<a class="lic-back" id="licBack" href="\/">/, 'which points at the dashboard');
    assert.match(PAGE, />\s*Back to Dashboard\s*</, 'the control is labelled plainly');
});

test('19. the Back control is a real link, so it works before any script runs', () => {
    const anchor = PAGE.match(/<a class="lic-back" id="licBack" href="\/">([\s\S]*?)<\/a>/);
    assert.ok(anchor, 'the back control is an anchor pointing at /');
    assert.match(anchor[1], /Back to Dashboard/);
    assert.match(PAGE, /<noscript>[\s\S]*?<img src="\/license\/kalderix-operating-license\.jpg"/,
        'the document is still readable with scripting disabled');
});

/* ------------------------------------------------------------------ *
 * 6. the section: placement + copy
 * ------------------------------------------------------------------ */

test('20. the dashboard section sits below the dashboard content, inside the overview view', () => {
    const overviewAt = INDEX.indexOf('id="kxViewOverview"');
    const walletsAt = INDEX.indexOf('<!-- /kxWallets -->');
    const cardAt = INDEX.indexOf('id="licenseCard"');
    assert.ok(overviewAt > 0 && walletsAt > overviewAt, 'the dashboard markers must exist');
    assert.ok(cardAt > walletsAt, 'the license card comes after the dashboard content');
    assert.match(INDEX, /<a class="kx-license-card" id="licenseCard" href="\/operating-license"/,
        'the whole card is the link to the viewer');
    assert.match(INDEX, /kx-license-icon[\s\S]{0,80}fa-file-shield/, 'a document/license icon');
    assert.match(INDEX, /id="licenseCardTitle" data-i18n="license\.title">View Operating License</,
        'the exact required title');
    assert.match(INDEX, /id="licenseCard"[\s\S]{0,1200}?data-i18n="license\.desc">View our operating license and regulatory documentation\.</,
        'the exact required description');
});

test('21. the landing page carries the same section above the footer (never inside it)', () => {
    const landingAt = INDEX.indexOf('<div id="landingPage"');
    const sectionAt = INDEX.indexOf('class="landing-license"');
    const footerAt = INDEX.indexOf('<footer class="landing-footer">');
    assert.ok(landingAt > 0 && sectionAt > landingAt, 'the section is part of the landing page');
    assert.ok(sectionAt < footerAt, 'it sits above the footer');
    const footerSlice = INDEX.slice(footerAt, INDEX.indexOf('</footer>', footerAt));
    assert.ok(!footerSlice.includes('operating-license'), 'it is not placed in the footer');
    assert.match(INDEX.slice(sectionAt, sectionAt + 900), /href="\/operating-license"/);
});

test('22. a signed-out visitor on the auth screen also has the entry point', () => {
    const authAt = INDEX.indexOf('<div id="authPage"');
    const authEnd = INDEX.indexOf('id="mainApp"');
    const linkAt = INDEX.indexOf('class="auth-license-link"');
    assert.ok(linkAt > authAt && linkAt < authEnd, 'the link is inside the auth screen');
    const linkMarkup = INDEX.slice(INDEX.lastIndexOf('<a ', linkAt), linkAt + 400);
    assert.match(linkMarkup, /href="\/operating-license"/);
    assert.match(linkMarkup, /data-i18n="license\.title"/);
});

test('23. the dashboard never preloads the document', () => {
    assert.ok(!INDEX.includes(DOC_URL), 'index.html must not reference the document asset');
    assert.ok(!INDEX.includes('/license/'), 'nor the asset directory');
    assert.ok(!/<img[^>]+operating-license/i.test(INDEX), 'no hidden document image in the dashboard');
});

test('24. all five keys are translated in all six locales', () => {
    const start = INDEX.indexOf('const TRANSLATIONS');
    let depth = 0, end = -1;
    for (let i = INDEX.indexOf('{', start); i < INDEX.length; i += 1) {
        if (INDEX[i] === '{') depth += 1;
        else if (INDEX[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
    }
    const T = vm.runInNewContext('(' + INDEX.slice(INDEX.indexOf('{', start), end + 1) + ')');
    const keys = ['license.title', 'license.desc', 'license.certLabel', 'license.status', 'license.cta'];
    assert.deepStrictEqual(Object.keys(T).sort(), ['ar', 'en', 'es', 'fr', 'pt', 'zh']);
    LANGS.forEach((lang) => {
        keys.forEach((key) => {
            const value = T[lang][key];
            assert.strictEqual(typeof value, 'string', lang + ' ' + key + ' must exist');
            assert.ok(value.trim(), lang + ' ' + key + ' must not be empty');
            assert.ok(!value.startsWith('license.'), lang + ' ' + key + ' must be translated');
        });
    });
    assert.strictEqual(T.en['license.title'], 'View Operating License');
    assert.strictEqual(T.en['license.desc'], 'View our operating license and regulatory documentation.');
    // Identical key sets, and every data-i18n reference resolves.
    const sizes = new Set(LANGS.map((l) => Object.keys(T[l]).length));
    assert.strictEqual(sizes.size, 1, 'identical key sets');
    const refs = Array.from(INDEX.matchAll(/data-i18n="(license\.[a-zA-Z]+)"/g)).map((m) => m[1]);
    assert.ok(refs.length >= 5, 'the markup wires the keys');
    refs.forEach((key) => assert.ok(T.en[key], key + ' must be defined'));
});

test('25. no fresh regulator claim is invented anywhere in the feature', () => {
    // The document is the authority for its own contents; the section quotes the
    // document's own title and nothing else.
    const surfaces = INDEX.slice(INDEX.indexOf('class="landing-license"'), INDEX.indexOf('<footer class="landing-footer">'))
        + INDEX.slice(INDEX.indexOf('id="licenseCard"'), INDEX.indexOf('id="licenseCard"') + 1400)
        + PAGE;
    ['AFM', 'Authority for the Financial Markets', 'licensed by', 'regulated by', 'SEC', 'FCA', 'CAC', 'BaFin']
        .forEach((claim) => {
            assert.ok(!surfaces.includes(claim), 'must not claim: ' + claim);
        });
    assert.ok(!/\bKVK\b/.test(surfaces), 'the company registration is not restated as a license credential');
});

/* ------------------------------------------------------------------ *
 * 7. nothing else moved
 * ------------------------------------------------------------------ */

test('26. the business constants and the money paths are untouched', () => {
    assert.match(SERVER, /const MIN_WITHDRAWAL_USD = 700;/);
    assert.match(SERVER, /const PROMO_PROFIT_CAP_USD = 30;/);
    assert.match(SERVER, /const PLATFORM_MIN_DEPOSIT_USD = 50;/);
    assert.match(SERVER, /function record_trade_safe|rpc\('record_trade_safe'/);
    // The feature adds one GET route and one asset guard; it defines no other route.
    const routes = SERVER.match(/app\.(get|post|put|delete)\(/g) || [];
    assert.ok(routes.length > 100, 'the route table is intact');
    assert.ok(!/app\.(post|put|delete)\(\[?'?\/operating-license/.test(SERVER),
        'the viewer is read-only: no write route');
});

test('27. the feature is additive: no existing dashboard id disappeared', () => {
    ['totalEquity', 'balanceValue', 'pnlValue', 'botStatus', 'availableDepositBtn', 'availableWithdrawBtn',
        'startHereCard', 'promoCreditBanner', 'kxCockpit', 'kxWallets', 'history', 'markets'].forEach((id) => {
        assert.ok(INDEX.includes('id="' + id + '"'), id + ' must still exist');
    });
    assert.ok(INDEX.includes('id="landingPage"') && INDEX.includes('id="authPage"') && INDEX.includes('id="mainApp"'));
});

test('28. the license page keeps the existing security boundaries', () => {
    // The unlisted business-registration document must stay unlisted.
    assert.ok(!PAGE.includes('business-registration'), 'the license page must not surface the unlisted page');
    assert.ok(!PAGE.includes('certificates/'), 'nor the private certificate folder');
    assert.ok(!/t\.me\//.test(PAGE), 'the license page is not a support destination');
    assert.ok(!/<form|<input|<textarea/i.test(PAGE), 'it collects no input');
    assert.match(PAGE, /<meta name="robots" content="index, follow">/, 'the public trust page is indexable');
});
