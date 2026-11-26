#!/usr/bin/env node
/**
 * 将全部 livepage HTML 接入离线豆包预合成语音引擎（../audio/manifest.js + ../vendor/voice.js）
 * 幂等可重复运行，并在修改后自动做 JS 语法校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_DIR = path.resolve(__dirname, '..', 'lessons');

const SCRIPT_INJECT = `<script src="../vendor/three.min.js"></script>\n<script src="../audio/manifest.js"></script>\n<script src="../vendor/voice.js"></script>`;

const UNIFIED_SPEAK = `function speak(text, force) {
  if (!text || (!voiceOn && !force)) return;
  if (window.__xkVoice) { window.__xkVoice.speak(text); return; }
  if (!('speechSynthesis' in window)) return;
  try { window.speechSynthesis.cancel(); var u = new SpeechSynthesisUtterance(text); u.lang = 'zh-CN'; u.rate = 0.94; u.pitch = 1.08; window.speechSynthesis.speak(u); } catch (e) {}
}`;

const files = fs.readdirSync(LESSONS_DIR).filter(f => /^k[1-6][ab]-.*\.html$/i.test(f)).sort();

for (const f of files) {
  const p = path.join(LESSONS_DIR, f);
  let html = fs.readFileSync(p, 'utf8');

  // 1) 注入 manifest.js + voice.js（幂等）
  if (!html.includes('../vendor/voice.js')) {
    if (!html.includes('<script src="../vendor/three.min.js"></script>')) {
      throw new Error(`Missing three.min.js script tag in ${f}`);
    }
    html = html.replace('<script src="../vendor/three.min.js"></script>', SCRIPT_INJECT);
  }

  // 2) 统一升级 speak() 优先走 window.__xkVoice
  const speakRe = /function\s+speak\s*\([^)]*\)\s*\{[\s\S]*?\n\}/;
  if (!speakRe.test(html)) throw new Error(`Missing function speak() in ${f}`);
  html = html.replace(speakRe, UNIFIED_SPEAK);

  // 3) 把其它取消播报位置（resetAll / voiceBtn 静音 / stopVoice）同步调用 window.__xkVoice.stop()
  //    保护 UNIFIED_SPEAK 内部的 cancel 不被误改
  const parts = html.split(UNIFIED_SPEAK);
  if (parts.length !== 2) throw new Error(`Unexpected speak split count in ${f}`);
  const fixCancel = (seg) => seg.replace(
    /window\.speechSynthesis\.cancel\(\)/g,
    '(window.__xkVoice ? window.__xkVoice.stop() : window.speechSynthesis.cancel())'
  );
  // 防止重复包裹
  const safeFixCancel = (seg) => seg.includes('window.__xkVoice.stop()') ? seg : fixCancel(seg);
  html = safeFixCancel(parts[0]) + UNIFIED_SPEAK + safeFixCancel(parts[1]);

  // 4) JS 语法自检
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scriptMatches.length === 0) throw new Error(`No inline script in ${f}`);
  for (const sm of scriptMatches) {
    new Function(sm[1]);
  }

  fs.writeFileSync(p, html, 'utf8');
  console.log(`[wired] ${f} -> OK`);
}
console.log(`ALL ${files.length} LIVEPAGES WIRED TO DOUBAO VOICE!`);
