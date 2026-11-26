/**
 * 用 Chrome DevTools Protocol 打开本地 HTML、执行一段 JS、然后截图。
 * 需要它是因为 `chrome --screenshot` 只能加载后直接拍，没法先点几下再拍。
 *
 * 用法：
 *   node tools/shot.mjs --out shots/a.png
 *   node tools/shot.mjs --out shots/a.png --js "__k1a13.go(3)"
 *   node tools/shot.mjs --out shots/a.png --js "..." --w 390 --h 844 --wait 1200
 *
 * 依赖：Node 22+ 自带的全局 WebSocket（不需要 npm 包）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const OUT = arg('--out', 'review/shots/shot.png');
const W = Number(arg('--w', 1920));
const H = Number(arg('--h', 1080));
const WAIT = Number(arg('--wait', 1000));
const JS = arg('--js', '');
const URL_ = arg('--url', 'file:///E:/Cc_file/xiaoxuekexue/lessons/k1a-13.html');
const PORT = Number(arg('--port', 9333));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!CHROME) throw new Error('找不到 chrome.exe');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });

  const profile = path.join(process.env.TEMP || '.', 'cdp-shot-' + PORT);
  const child = spawn(CHROME, [
    '--headless=new',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    '--hide-scrollbars',
    '--allow-file-access-from-files',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    `--window-size=${W},${H}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let list = null;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      list = await r.json();
      if (list.some((t) => t.type === 'page')) break;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  const page = (list || []).find((t) => t.type === 'page');
  if (!page) { child.kill(); throw new Error('连不上 Chrome 的调试端口'); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');

  /* 监听必须放在 navigate 之前，才能抓到页面加载时的异常 */
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push((m.params.args || []).map((a) => a.value ?? a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails || {};
      logs.push('EXCEPTION: ' + (d.exception?.description || d.text) +
        (d.lineNumber != null ? ` @${d.lineNumber + 1}:${(d.columnNumber || 0) + 1}` : ''));
    }
  });

  await send('Emulation.setDeviceMetricsOverride', {
    width: W, height: H, deviceScaleFactor: 1, mobile: W < 600,
  });
  await send('Page.navigate', { url: URL_ });
  await sleep(WAIT);

  if (JS) {
    const r = await send('Runtime.evaluate', { expression: JS, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      console.error('JS 出错:', JSON.stringify(r.result.exceptionDetails).slice(0, 400));
    } else if (r.result?.result?.value !== undefined) {
      console.log('JS 返回:', JSON.stringify(r.result.result.value).slice(0, 300));
    }
    await sleep(600);
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (!shot.result?.data) { console.error('截图失败', JSON.stringify(shot).slice(0, 300)); }
  else {
    fs.writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
    console.log(`截图: ${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
  }
  if (logs.length) console.log('控制台错误:\n' + logs.join('\n'));

  ws.close();
  child.kill();
  process.exit(0);
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
