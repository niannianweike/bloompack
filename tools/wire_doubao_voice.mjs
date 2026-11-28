#!/usr/bin/env node
/**
 * 将全部 livepage HTML 接入离线豆包预合成语音引擎（../audio/manifest.js?v=doubao-2 + ../vendor/voice.js?v=doubao-2）
 * 统一强制纯豆包原声（doubaoOnly = true），杜绝回落到浏览器机械 TTS。
 * 幂等可重复运行，并在修改后自动做 JS 语法校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LESSONS_DIR = path.resolve(__dirname, '..', 'lessons');

const VOICE_VER = 'doubao-2';
const SCRIPT_INJECT = `<script src="../vendor/three.min.js"></script>\n<script src="../audio/manifest.js?v=${VOICE_VER}"></script>\n<script src="../vendor/voice.js?v=${VOICE_VER}"></script>`;

const UNIFIED_SPEAK_VOICEON = `function speak(text, force) {
  if (!text || (!voiceOn && !force)) return;
  if (window.__xkVoice) { window.__xkVoice.speak(text, '../audio/', true); return; }
}`;

const UNIFIED_SPEAK_MUTED = `function speak(txt, force) {
  if (!txt || (muted && !force)) return;
  if (window.__xkVoice) { window.__xkVoice.speak(txt, '../audio/', true); return; }
}`;

const files = fs.readdirSync(LESSONS_DIR).filter(f => /^k[1-6][ab]-.*\.html$/i.test(f)).sort();

for (const f of files) {
  const p = path.join(LESSONS_DIR, f);
  let html = fs.readFileSync(p, 'utf8');

  // 1) 注入或刷新 manifest.js + voice.js 版本号（幂等）
  if (!html.includes('../vendor/voice.js')) {
    if (!html.includes('<script src="../vendor/three.min.js"></script>')) {
      throw new Error(`Missing three.min.js script tag in ${f}`);
    }
    html = html.replace('<script src="../vendor/three.min.js"></script>', SCRIPT_INJECT);
  } else {
    html = html.replace(/\.\.\/audio\/manifest\.js(?:\?[^"']*)?/g, `../audio/manifest.js?v=${VOICE_VER}`);
    html = html.replace(/\.\.\/vendor\/voice\.js(?:\?[^"']*)?/g, `../vendor/voice.js?v=${VOICE_VER}`);
  }

  // 2) 统一升级 speak() 强制走 window.__xkVoice 纯豆包（自动识别 muted vs voiceOn）
  const speakRe = /function\s+speak\s*\([^)]*\)\s*\{[\s\S]*?\n\}/;
  const m = html.match(speakRe);
  if (!m) throw new Error(`Missing function speak() in ${f}`);
  const usesMuted = /\bmuted\b/.test(m[0]) && !/\bvoiceOn\b/.test(m[0]);
  const targetSpeak = usesMuted ? UNIFIED_SPEAK_MUTED : UNIFIED_SPEAK_VOICEON;
  html = html.replace(speakRe, targetSpeak);

  // 3) 把其它取消播报位置同步调用 window.__xkVoice.stop()
  const parts = html.split(targetSpeak);
  if (parts.length !== 2) throw new Error(`Unexpected speak split count in ${f}`);
  const fixCancel = (seg) => seg.replace(
    /window\.speechSynthesis\.cancel\(\)/g,
    '(window.__xkVoice ? window.__xkVoice.stop() : window.speechSynthesis.cancel())'
  );
  const safeFixCancel = (seg) => seg.includes('window.__xkVoice.stop()') ? seg : fixCancel(seg);
  html = safeFixCancel(parts[0]) + targetSpeak + safeFixCancel(parts[1]);

  // 4) JS 语法自检
  const scriptMatches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scriptMatches.length === 0) throw new Error(`No inline script in ${f}`);
  for (const sm of scriptMatches) {
    new Function(sm[1]);
  }

  fs.writeFileSync(p, html, 'utf8');
  console.log(`[wired] ${f} (${usesMuted ? 'muted' : 'voiceOn'}) -> OK`);
}
console.log(`ALL ${files.length} LIVEPAGES WIRED TO PURE DOUBAO VOICE (v=${VOICE_VER})!`);
