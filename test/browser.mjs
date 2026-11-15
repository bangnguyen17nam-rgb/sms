import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const base = new URL(process.env.SMS_TEST_URL || 'http://127.0.0.1:8790');
if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('Browser tests must target a local HTTP server.');
}
const winChrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const winEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const chromePath = process.env.CHROME_PATH || [winChrome, winEdge, '/usr/bin/google-chrome', '/usr/bin/chromium'].find(existsSync);
if (!chromePath) throw new Error('Set CHROME_PATH to a local Chrome/Edge/Chromium executable.');

mkdirSync('.wrangler', { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ['--disable-background-networking'] });
const errors = [];
const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
const alice = 'ui_a_' + suffix;
const bob = 'ui_b_' + suffix;
const password = 'Tester_' + suffix + '_ok';
let steps = 0;
function pass(message) { steps++; console.log('PASS ' + steps + ': ' + message); }
async function register(page, username, name) {
  await page.getByRole('tab', { name: 'Tạo tài khoản' }).click();
  await page.locator('#registerDisplayName').fill(name);
  await page.locator('#registerUsername').fill(username);
  await page.locator('#registerPassword').fill(password);
  await page.locator('#registerForm .auth-submit').click();
  await page.locator('#appShell').waitFor({ state: 'visible', timeout: 10000 });
}

try {
  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
  const mobile = await mobileContext.newPage();
  mobile.on('pageerror', error => errors.push('mobile: ' + error.message));
  await mobile.goto(base.origin, { waitUntil: 'networkidle' });
  await mobile.screenshot({ path: '.wrangler/visual-mobile.png' });
  const mobileWidth = await mobile.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert.ok(mobileWidth.page <= mobileWidth.viewport, 'Auth screen overflows mobile viewport: ' + JSON.stringify(mobileWidth));
  pass('390px auth page without horizontal overflow');
  await mobile.setViewportSize({ width: 320, height: 740 });
  const compactWidth = await mobile.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert.ok(compactWidth.page <= compactWidth.viewport, 'Auth screen overflows 320px viewport: ' + JSON.stringify(compactWidth));
  pass('320px auth without horizontal overflow');
  await mobile.setViewportSize({ width: 390, height: 844 });
  await register(mobile, alice, 'Tester Mobile');
  await mobile.locator('#conversationList .conversation-empty').waitFor({ state: 'visible', timeout: 10000 });
  pass('Register and enter inbox on mobile');
  await mobile.screenshot({ path: '.wrangler/visual-mobile-inbox.png' });
  const appWidth = await mobile.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert.ok(appWidth.page <= appWidth.viewport, 'Inbox overflows mobile viewport: ' + JSON.stringify(appWidth));
  pass('390px inbox without horizontal overflow');

  const desktopContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const desktop = await desktopContext.newPage();
  desktop.on('pageerror', error => errors.push('desktop: ' + error.message));
  await desktop.goto(base.origin, { waitUntil: 'networkidle' });
  await desktop.screenshot({ path: '.wrangler/visual-desktop.png' });
  await register(desktop, bob, 'Tester Desktop');
  pass('Second user can register in another browser session');

  await mobile.locator('#newChatButton').click();
  await mobile.locator('#userSearch').fill(bob);
  await mobile.locator('#userResults [data-username]').first().waitFor({ timeout: 10000 });
  await mobile.locator('#userResults [data-username]').first().click();
  await mobile.locator('#activeName').waitFor({ state: 'visible' });
  assert.equal(await mobile.locator('#activeName').innerText(), 'Tester Desktop');
  pass('Search for a user and create a direct conversation');

  await mobile.locator('#messageInput').fill('Chào từ kiểm thử giao diện');
  await mobile.locator('#sendButton').click();
  await mobile.locator('.message-bubble').getByText('Chào từ kiểm thử giao diện').waitFor({ timeout: 10000 });
  await mobile.locator('#chatPanel').evaluate(element => new Promise(resolve => {
    if (getComputedStyle(element).transitionDuration === '0s') return resolve();
    element.addEventListener('transitionend', resolve, { once: true });
    setTimeout(resolve, 500);
  }));
  await mobile.screenshot({ path: '.wrangler/visual-mobile-chat.png' });
  const chatWidth = await mobile.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert.ok(chatWidth.page <= chatWidth.viewport, 'Chat overflows 390px viewport: ' + JSON.stringify(chatWidth));
  const chatBounds = await mobile.locator('#chatPanel').boundingBox();
  if (chatBounds && Math.abs(chatBounds.x) >= 2) console.log('CHAT GEOMETRY', await mobile.evaluate(() => Object.fromEntries(['html', 'body', 'appShell', 'chatPanel', 'detailsDrawer'].map(id => { const el = id === 'html' ? document.documentElement : id === 'body' ? document.body : document.getElementById(id); return [id, { x: el.getBoundingClientRect().x, width: el.getBoundingClientRect().width, scrollLeft: el.scrollLeft, scrollWidth: el.scrollWidth, transform: getComputedStyle(el).transform, position: getComputedStyle(el).position, display: getComputedStyle(el).display }]; }))));
  assert.ok(chatBounds && Math.abs(chatBounds.x) < 2 && chatBounds.width >= 388, 'Chat panel does not fill mobile viewport: ' + JSON.stringify(chatBounds));
  pass('Mobile chat viewport and composer do not overflow');
  await desktop.locator('#conversationList .conversation-item').first().waitFor({ timeout: 15000 });
  await desktop.locator('#conversationList .conversation-item').first().click();
  await desktop.locator('.message-bubble').getByText('Chào từ kiểm thử giao diện').waitFor({ timeout: 10000 });
  pass('Message sent and received between two sessions');

  const fileInput = mobile.locator('#fileInput');
  await fileInput.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Browser attachment test') });
  await mobile.locator('#attachmentPreview').waitFor({ state: 'visible' });
  await mobile.locator('#sendButton').click();
  await mobile.locator('.message-file-card').first().waitFor({ timeout: 12000 });
  pass('File selection, preview and upload work');

  await mobile.locator('#infoButton').click();
  await mobile.locator('#messageSearchButton').click();
  await mobile.locator('#messageSearchInput').fill('kiểm thử');
  await mobile.locator('.message-search-result').first().waitFor({ timeout: 10000 });
  await mobile.locator('.message-search-result').first().click();
  pass('Server-side message search opens a result');

  await mobile.locator('#infoButton').click();
  await mobile.locator('#archiveConversationButton').click();
  await mobile.locator('#archiveChip').click();
  await mobile.locator('#conversationList .conversation-item').first().waitFor({ timeout: 10000 });
  pass('Archive tab lists archived conversation');

  await mobile.locator('#mobileProfile').click();
  await mobile.locator('#editProfileButton').click();
  await mobile.locator('#profileDisplayNameInput').fill('Tester Renamed');
  await mobile.locator('#profileEditForm button').click();
  await mobile.locator('#profileName').getByText('Tester Renamed').waitFor();
  pass('Profile can be updated');
  await mobile.locator('#logoutButton').click();
  await mobile.locator('#loginForm').waitFor({ state: 'visible' });
  await mobile.locator('#loginUsername').fill(alice);
  await mobile.locator('#loginPassword').fill(password);
  await mobile.locator('#loginForm .auth-submit').click();
  await mobile.locator('#appShell').waitFor({ state: 'visible' });
  pass('Logout then login restores the account');

  assert.deepEqual(errors, [], 'Browser JavaScript errors: ' + errors.join('; '));
  pass('No uncaught browser JavaScript errors');
  console.log('BROWSER PASS: ' + steps + ' interactive checks and screenshots at .wrangler/visual-*.png');
} catch (error) {
  console.error('BROWSER FAIL:', error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
