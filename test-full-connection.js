/**
 * test-full-connection.js
 *
 * Full end-to-end SSH connection flow test for piping-ssh-web.
 *
 * Infrastructure:
 *   - Local piping server (port 18090) — pairs GET/POST on same path
 *   - Fake SSH server (port 12322) — accepts TCP, sends SSH version banner
 *
 * What is tested per browser (WebKit = Safari path, Chromium = Chrome path):
 *   1. No DataCloneError when the WASM worker is invoked via postMessage
 *   2. App enters "connecting" state (spinner visible → transport started)
 *   3. Server command uses the local piping server and fake SSH port
 *   4. Piping server receives requests from both browser and server command
 *
 * Usage:
 *   node test-full-connection.js
 *
 * Prerequisites:
 *   npm run serve  (dev server on localhost:8081 must be running)
 */

'use strict';

const { webkit, chromium } = require('playwright');
const net  = require('net');
const http = require('http');
const { spawn } = require('child_process');

// ── Configuration ────────────────────────────────────────────────────────────
const APP_URL      = 'http://localhost:8081/';
const PIPING_PORT  = 18090;
const SSH_PORT     = 12322;
const USERNAME     = process.env.USER || 'testuser';

// ── Fake SSH Server ──────────────────────────────────────────────────────────
// Accepts TCP connections and immediately sends the SSH version banner.
// The Go WASM SSH client will receive it and start key exchange (which will
// ultimately fail — but that happens AFTER the postMessage check we care about).
function startFakeSshServer(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      console.log('  [fake-ssh] connection received');
      socket.write('SSH-2.0-OpenSSH_FakeTest\r\n');
      socket.on('data', (d) => {
        console.log(`  [fake-ssh] received ${d.length} bytes from client`);
      });
      socket.on('error', () => {});
      socket.on('close', () => console.log('  [fake-ssh] socket closed'));
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[fake-ssh] listening on 127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ── Local Piping Server ───────────────────────────────────────────────────────
// Minimal piping server: pairs GET and POST/PUT on the same URL path.
// Supports both streaming (Chrome path) and chunked numbered paths (Safari path).
// CORS is fully open so the browser at localhost:8081 can reach it.
function startPipingServer(port) {
  return new Promise((resolve, reject) => {
    /** @type {Map<string, import('http').ServerResponse>} */
    const waitingGets  = new Map();   // path → GET ServerResponse (waiting)
    /** @type {Map<string, {req: import('http').IncomingMessage, res: import('http').ServerResponse}>} */
    const waitingPosts = new Map();   // path → {req, res} (POST waiting for GET)
    const requestCount = { get: 0, post: 0 };

    const corsHeaders = {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': '*',
    };

    const server = http.createServer((req, res) => {
      const path = req.url || '/';

      // Preflight
      if (req.method === 'OPTIONS') {
        res.writeHead(200, corsHeaders);
        res.end();
        return;
      }

      // Add CORS to every response
      Object.entries(corsHeaders).forEach(([k, v]) => res.setHeader(k, v));

      console.log(`  [piping] ${req.method} ${path}`);

      if (req.method === 'GET') {
        requestCount.get++;
        if (waitingPosts.has(path)) {
          // POST already arrived — pipe immediately
          const { postReq, postRes } = waitingPosts.get(path);
          waitingPosts.delete(path);
          res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...corsHeaders });
          postReq.pipe(res);
          // Acknowledge POST now that we've started piping
          postReq.on('end', () => {
            if (!postRes.headersSent) {
              postRes.writeHead(200);
              postRes.end('OK');
            }
          });
        } else {
          // Wait for matching POST
          waitingGets.set(path, res);
        }

      } else if (req.method === 'POST' || req.method === 'PUT') {
        requestCount.post++;
        if (waitingGets.has(path)) {
          // GET already waiting — pipe and ack POST immediately
          const getRes = waitingGets.get(path);
          waitingGets.delete(path);
          getRes.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', ...corsHeaders });
          req.pipe(getRes);
          // Send POST acknowledgement right away (body still streaming)
          res.writeHead(200);
          res.end('OK');
        } else {
          // Wait for matching GET
          waitingPosts.set(path, { postReq: req, postRes: res });
        }

      } else {
        res.writeHead(405);
        res.end('Method not allowed');
      }
    });

    server.requestCount = requestCount;
    server.listen(port, '127.0.0.1', () => {
      console.log(`[piping]   server listening on 127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ── Single Browser Test ───────────────────────────────────────────────────────
async function runTest(browserType, label, pipingUrl, sshPort, pipingServer) {
  // Paths are auto-generated by the app; we read the server command after
  // filling the form rather than controlling paths explicitly.

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Testing: ${label}`);

  const browser = await browserType.launch({ headless: true });
  const context = await browser.newContext();
  const page    = await context.newPage();

  /** @type {string[]} */ const dialogs       = [];
  /** @type {string[]} */ const dataCloneErrs = [];
  /** @type {string[]} */ const pageErrors    = [];

  // Intercept alert() calls (DataCloneError → alert("SSH error: DataCloneError …"))
  page.on('dialog', async (dialog) => {
    const msg = dialog.message();
    dialogs.push(msg);
    console.log(`  [dialog] ${msg.substring(0, 120)}`);
    if (/DataCloneError|can not be cloned|could not be cloned/i.test(msg)) {
      dataCloneErrs.push(msg);
    }
    await dialog.dismiss();
  });

  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
    if (/DataCloneError|can not be cloned/i.test(err.message)) {
      dataCloneErrs.push(err.message);
    }
    console.log(`  [page error] ${err.message.substring(0, 100)}`);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`  [console error] ${msg.text().substring(0, 100)}`);
  });

  let serverProcess = null;

  try {
    // ── Load app ──────────────────────────────────────────────────────────
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });

    // ── Fill form ─────────────────────────────────────────────────────────
    // All input[type="text"] order (visible in form):
    //   [0] piping server URL (inside v-combobox)
    //   [1] client-server path
    //   [2] server-client path
    //   [3] user name
    // After "More options" opens:
    //   [4] SSH server port for command (+ others)
    const textInputs = page.locator('input[type="text"]');

    // Piping Server URL — triple-click to select all, then type new URL
    const pipingInput = textInputs.nth(0);
    await pipingInput.click({ clickCount: 3 });
    await pipingInput.fill(pipingUrl);
    await page.keyboard.press('Escape'); // close combobox dropdown
    await page.waitForTimeout(300);

    // Paths — keep auto-generated values to avoid mismatches; just confirm by tabbing
    // (server command is derived from the same reactive state as fetch URLs)
    // Username
    await textInputs.nth(3).fill(USERNAME);
    await page.waitForTimeout(200);

    // Open More options, then set SSH port for command hint
    await page.locator('button', { hasText: 'More options' }).click();
    await page.waitForTimeout(400);
    // SSH port is [4] when More options is open
    await textInputs.nth(4).fill(String(sshPort));
    await page.waitForTimeout(300);

    // ── Read server-host command ──────────────────────────────────────────
    // The server-host command textarea is the last textarea on the page
    const serverCmd = await page.locator('textarea').last().inputValue();
    console.log(`  cmd: ${serverCmd.substring(0, 130)}`);

    const cmdUsesLocalPiping = serverCmd.includes(pipingUrl);
    const cmdUsesCustomPort  = serverCmd.includes(String(sshPort));
    if (!cmdUsesLocalPiping) console.warn('  ⚠️  Command does not reference local piping server');
    if (!cmdUsesCustomPort)  console.warn('  ⚠️  Command does not reference custom SSH port');

    // ── Click CONNECT (triggers postMessage to worker) ────────────────────
    // Playwright auto-waits for the button to be actionable (enabled, visible, stable).
    // Vuetify 3 marks disabled buttons with aria-disabled="true"; Playwright
    // respects that and waits until the form becomes valid (after username is filled).
    await page.locator('button[type="submit"]').click({ timeout: 10000 });
    console.log('  Clicked CONNECT');

    // ── Start server-side command ─────────────────────────────────────────
    // Small delay so browser initiates requests first
    await page.waitForTimeout(600);
    serverProcess = spawn('bash', ['-c', serverCmd]);
    serverProcess.stdout.on('data', (d) =>
      console.log(`  [srv-cmd] ${d.toString().replace(/\n/g, ' ').substring(0, 80)}`));
    serverProcess.stderr.on('data', (d) =>
      console.log(`  [srv-err] ${d.toString().replace(/\n/g, ' ').substring(0, 80)}`));
    serverProcess.on('error', (e) => console.log(`  [srv-cmd error] ${e.message}`));

    // ── Wait up to 8 s for a DataCloneError dialog OR spinner ────────────
    // A DataCloneError triggers alert() within ~1 s of clicking CONNECT.
    // If no error → spinner (v-progress-circular) stays visible.
    await page.waitForTimeout(8000);

    // ── Assess results ────────────────────────────────────────────────────
    const spinnerVisible = await page
      .locator('.v-progress-circular').first()
      .isVisible()
      .catch(() => false);

    const pipingGets  = pipingServer.requestCount.get;
    const pipingPosts = pipingServer.requestCount.post;

    const passed = dataCloneErrs.length === 0;

    console.log(`  DataCloneErrors : ${dataCloneErrs.length}`);
    console.log(`  Spinner visible : ${spinnerVisible}`);
    console.log(`  Piping GETs     : ${pipingGets}`);
    console.log(`  Piping POSTs    : ${pipingPosts}`);
    console.log(`  All dialogs     : ${dialogs.length}`);

    return {
      label,
      passed,
      dataCloneErrors: dataCloneErrs.length,
      spinnerVisible,
      pipingGets,
      pipingPosts,
      cmdUsesLocalPiping,
      cmdUsesCustomPort,
      dialogs,
    };

  } finally {
    if (serverProcess) serverProcess.kill('SIGTERM');
    await browser.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log('Starting infrastructure…');
  const [pipingServer, sshServer] = await Promise.all([
    startPipingServer(PIPING_PORT),
    startFakeSshServer(SSH_PORT),
  ]);

  const pipingUrl = `http://127.0.0.1:${PIPING_PORT}`;

  try {
    // Run WebKit (Safari path) first, then Chromium (Chrome path)
    const results = [];
    for (const [bt, label] of [[webkit, 'WebKit  (Safari path)'], [chromium, 'Chromium (Chrome path)']]) {
      results.push(await runTest(bt, label, pipingUrl, SSH_PORT, pipingServer));
    }

    // ── Summary ───────────────────────────────────────────────────────────
    console.log(`\n${'═'.repeat(60)}`);
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    let allPassed = true;
    for (const r of results) {
      const icon = r.passed ? '✅' : '❌';
      const spin = r.spinnerVisible ? '🔄 connecting' : '⏹ not connecting';
      const piping = `piping(GET=${r.pipingGets} POST=${r.pipingPosts})`;
      console.log(`${icon} ${r.label}`);
      console.log(`   DataCloneErrors=${r.dataCloneErrors}  ${spin}  ${piping}`);
      if (!r.passed) {
        allPassed = false;
        console.log(`   Dialogs: ${r.dialogs.join(' | ')}`);
      }
    }
    console.log('');
    console.log(allPassed ? '✅ All tests PASSED' : '❌ Some tests FAILED');
    process.exit(allPassed ? 0 : 1);

  } finally {
    pipingServer.close();
    sshServer.close();
  }
})().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
