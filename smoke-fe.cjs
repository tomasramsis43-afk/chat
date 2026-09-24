const { chromium } = require('playwright');
const { createServer } = require('./src/app');
const { ensureMigrated } = require('./src/migrate');

const user = (p) => 'fe_' + p + Math.random().toString(36).slice(2, 8);
const PASSWORD = 'password123';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, predicateFn, timeout = 8000, label = 'condition') {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await predicateFn()) return;
    } catch {}
    await sleep(120);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function register(page, username) {
  await page.getByRole('tab', { name: 'حساب جديد' }).click();
  await page.fill('#register-username', username);
  await page.fill('#register-password', PASSWORD);
  await page.click('#register-form button[type=submit]');
  await waitFor(page, () => page.isVisible('#app-screen'), 8000, 'app screen after register');
}

async function openDm(page, otherName) {
  await page.fill('#search-input', otherName.slice(0, 6));
  await waitFor(page, async () => (await page.locator('.search-item').count()) > 0, 8000, 'search results');
  await page.locator('.search-item', { hasText: otherName }).first().click();
  await waitFor(
    page,
    async () => (await page.isVisible('#chat-open')) && (await page.textContent('#chat-name')) === otherName,
    8000,
    'dm opened'
  );
}

async function sendMsg(page, text) {
  await page.fill('#message-input', text);
  await page.click('#send-btn');
  await waitFor(
    page,
    async () => (await page.locator('.msg-row.mine .bubble', { hasText: text }).count()) > 0,
    8000,
    `msg ${text} rendered`
  );
}

async function expectMsg(page, text, mine = false) {
  const rowCls = mine ? '.msg-row.mine' : '.msg-row.theirs';
  await waitFor(
    page,
    async () => (await page.locator(`${rowCls} .bubble`, { hasText: text }).count()) > 0,
    8000,
    `msg ${text}`
  );
}

(async () => {
  await ensureMigrated();
  const { server } = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;

  const browser = await chromium.launch({ headless: true });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();

  A.on('pageerror', (e) => console.log('A pageerror:', e.message));
  B.on('pageerror', (e) => console.log('B pageerror:', e.message));
  A.on('console', (m) => {
    if (m.type() === 'error') console.log('A console error:', m.text());
  });
  B.on('console', (m) => {
    if (m.type() === 'error') console.log('B console error:', m.text());
  });

  const nameA = user('a');
  const nameB = user('b');

  try {
    await A.goto(base);
    await waitFor(A, () => A.isVisible('#auth-screen'), 6000, 'auth screen');
    await register(A, nameA);
    await waitFor(A, async () => (await A.textContent('#my-name')) === nameA, 6000, 'my name A');

    await B.goto(base);
    await register(B, nameB);
    await waitFor(B, async () => (await B.textContent('#my-name')) === nameB, 6000, 'my name B');

    await openDm(A, nameB);
    await openDm(B, nameA);

    const msg1 = 'اهلا من A';
    await sendMsg(A, msg1);
    await expectMsg(B, msg1);
    await waitFor(
      B,
      async () => (await B.locator('.conv-item', { hasText: nameA }).count()) > 0,
      6000,
      'list preview'
    );

    await B.click('#message-input');
    await B.fill('#message-input', 'j');
    await waitFor(A, () => A.isVisible('#typing-badge'), 6000, 'typing badge');
    await B.fill('#message-input', '');

    const msg2 = 'رد من B';
    await sendMsg(B, msg2);
    await expectMsg(A, msg2);

    await waitFor(
      A,
      async () => (await A.locator('.msg-row.mine .msg-state.read').count()) > 0,
      8000,
      'read receipts'
    );

    await B.click('#logout-btn');
    await waitFor(B, () => B.isVisible('#auth-screen'), 6000, 'logout');

    console.log('E2E SMOKE TEST PASSED');
  } finally {
    await browser.close();
    server.close();
  }
  process.exit(0);
})().catch((e) => {
  console.error('E2E FAILED:', e.message);
  process.exit(1);
});