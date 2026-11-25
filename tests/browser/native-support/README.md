# Native in-app support - browser verification

Real Chromium (puppeteer-core) against the real `public/index.html`; only the
backend is stubbed (`stub.js`), so no database, no invoice and no real message.

    npm install --no-save puppeteer-core     # not a production dependency
    ns_shots_dir=$(mktemp -d)
    node tests/browser/native-support/browser.js

Requires a Chromium binary (`CHROME_PATH`, default `/usr/bin/chromium`).

Covered: customer widget first open, category pick -> conversation creation,
send + AI reply rendering, failed send + retry, human request, unread badge,
panel fit / horizontal overflow at 360/390/430, Arabic RTL; admin inbox list,
counts, thread history, customer context, agent reply, takeover/resume/assign/
resolve (state-driven toolbar), administrator-initiated conversation, 1280 and
390 layouts, `elementFromPoint` hit-testing of the launcher / close button /
inbox row, and `no product page errors`.

The harness bypasses `initApp()` (the app's flex shell needs a live session), so
it flattens `#mainApp` and reveals the admin panel. That is why the inbox-row
hit-test runs on a tall viewport: it measures z-order/overlap, not device height.
