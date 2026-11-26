#!/usr/bin/env node
/**
 * 豆包语音 V3（Seed-TTS 2.0）离线预合成工具
 * 用法：
 *   1) 仅扫描统计台词：node tools/doubao_tts_sync.mjs --dry
 *   2) 批量合成 MP3 + 生成 audio/manifest.js：
 *      $env:DOUBAO_API_KEY="你的APIKey"; node tools/doubao_tts_sync.mjs
 *
 * 注意：API Key 仅通过环境变量 DOUBAO_API_KEY 传入，绝不写入任何前端 HTML 或代码仓库！
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const LESSONS_DIR = path.join(ROOT, 'lessons');
const AUDIO_DIR = path.join(ROOT, 'audio');
const MANIFEST_PATH = path.join(AUDIO_DIR, 'manifest.js');

const ENDPOINT = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const RESOURCE_ID = process.env.DOUBAO_RESOURCE_ID || 'seed-tts-2.0';
const SPEAKER = process.env.DOUBAO_SPEAKER || 'zh_female_tianmeixiaoyuan_uranus_bigtts';
const SPEECH_RATE = Number(process.env.DOUBAO_SPEECH_RATE ?? -8);
const BIT_RATE = Number(process.env.DOUBAO_BIT_RATE ?? 32000);
const CONCURRENCY = Number(process.env.DOUBAO_CONCURRENCY ?? 4);

export function normText(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩✦★☆✓✔✗✘▶↺🔊]/g, '')
    .replace(/[「」『』【】《》“”"']/g, '')
    .replace(/[·•]/g, '，')
    .replace(/\s+/g, '')
    .replace(/[，,、]+/g, '，')
    .replace(/[。！!？?；;：:]+$/g, '')
    .trim();
}

export function cleanForTTS(raw) {
  return String(raw || '')
    .replace(/<[^>]+>/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[①②③④⑤⑥⑦⑧⑨⑩✦★☆✓✔✗✘▶↺🔊]/g, '')
    .replace(/[·•]/g, '，')
    .replace(/\s+/g, ' ')
    .trim();
}

function hashKey(norm) {
  return 'v_' + crypto.createHash('sha1').update(norm).digest('hex').slice(0, 10) + '.mp3';
}

function unescapeJsStr(s) {
  return s.replace(/\\n/g, ' ').replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function isLikelySpoken(s) {
  if (!s) return false;
  if (/<[a-z/]/i.test(s)) return false;
  if (/^[a-z0-9_.:/#-]+$/i.test(s)) return false;
  if (!/[\u4e00-\u9fff]/.test(s)) return false;
  const n = normText(s);
  if (n.length < 2 || n.length > 140) return false;
  // Exclude pure CSS / pinyin / single short labels unlikely to be spoken
  if (/^[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜa-z\s]+$/i.test(s)) return false;
  return true;
}

function extractLinesFromHtml(html, fname) {
  const found = new Map(); // norm -> rawForTTS
  const add = (raw) => {
    const cleaned = cleanForTTS(unescapeJsStr(raw));
    if (!isLikelySpoken(cleaned)) return;
    const key = normText(cleaned);
    if (!key || key === '科学小结论' || key.length < 4) return;
    if (!found.has(key)) found.set(key, cleaned);
  };

  // HTML data-hint="..." attributes
  for (const m of html.matchAll(/data-hint\s*=\s*"([^"]+)"/g)) add(m[1]);

  const sm = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!sm) return found;
  const script = sm[1];

  // Extract all JS string literals in speech-related contexts
  const patterns = [
    /\bspeak\s*\(\s*(['"])((?:\\.|(?!\1).)+?)\1/g,
    /\b(?:WELCOME_TXT|INTRO_VOICE|GUIDE_TEXT|CONCL_SPEECH|curGuideSpeech|currentGuideSpeech|guideSpeech|sp|spoken|okText|tip|fb\.textContent|msg)\s*=\s*(['"])((?:\\.|(?!\1).)+?)\1/g,
    /\b(?:voice|speakText|shortNext|skyAnn|spoken|speech|say|hint|tip|ok|bad|wrong|concl|text|explain|sayOk|sayBad|narration|guide)\s*:\s*(['"])((?:\\.|(?!\1).)+?)\1/g,
    /\bdiscover\s*\([\s\S]{0,260}?,\s*(['"])((?:\\.|(?!\1).)+?)\1\s*(?:,\s*(?:true|false))?\s*\)/g,
    /\b(?:s|step|steps|DEMO)\b[\s\S]{0,60}?(['"])((?:\\.|(?!\1).){6,}?)\1/g,
    /\?\s*(['"])((?:\\.|(?!\1).){5,}?)\1\s*:\s*(['"])((?:\\.|(?!\1).){5,}?)\3/g,
    /\[\s*(?:[\d.]+|'[a-z0-9_-]+')\s*,\s*(['"])((?:\\.|(?!\1).){6,}?)\1/g,
    /\[\s*[\d.]+\s*,\s*['"][a-z0-9_-]+['"]\s*,\s*(['"])((?:\\.|(?!\1).){6,}?)\1/g
  ];

  for (const pat of patterns) {
    for (const m of script.matchAll(pat)) {
      if (m[2]) add(m[2]);
      if (m[4]) add(m[4]);
    }
  }

  // Catch any remaining Chinese sentence (>= 6 Hanzi chars with punctuation or verb) inside quotes
  for (const m of script.matchAll(/(['"])((?:\\.|(?!\1).){6,140}?)\1/g)) {
    const s = unescapeJsStr(m[2]);
    if (/<[a-z/]/i.test(s)) continue;
    const hanCount = (s.match(/[\u4e00-\u9fff]/g) || []).length;
    if (hanCount >= 6 && /[，。！？!?]/.test(s)) add(s);
  }

  // Lesson-specific finite dynamic expansions so 0 dynamic utterances fall back to robotic TTS
  if (fname === 'k1a-02-span.html') {
    const items = [
      ['橡皮', '比一拃短'], ['粉笔', '比一拃短'],
      ['水彩笔', '正好一拃'], ['铅笔', '正好一拃'],
      ['尺子', '比一拃长'], ['毛笔', '比一拃长']
    ];
    for (const [name, lab] of items) {
      add(`${name}${lab}！快把它拖进右边${lab}的木格里吧！`);
      add(`${name}${lab}，放对啦！`);
    }
    for (let rem = 1; rem <= 5; rem++) {
      add(`还剩${rem}件文具没量哦，拖到左边绿垫子上量一量吧！`);
    }
  }
  if (fname === 'k1a-03-book.html') {
    for (const m of ['木板', '铁板', '布', '玻璃']) {
      add(`换成${m}课本啦！`);
    }
  }
  if (fname === 'k1a-02.html') {
    for (const lbl of ['红盘', '黄盘', '蓝盘', '大盘', '小盘', '长方体盘', '圆柱体盘', '圆球体盘']) {
      add(`这是${lbl}！`);
    }
  }

  return found;
}

async function synthesizeOne(text, outPath, apiKey) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': apiKey,
          'X-Api-Resource-Id': RESOURCE_ID
        },
        body: JSON.stringify({
          req_params: {
            text,
            speaker: SPEAKER,
            audio_params: {
              format: 'mp3',
              sample_rate: 24000,
              bit_rate: BIT_RATE,
              speech_rate: SPEECH_RATE
            }
          }
        })
      });
      const body = await res.text();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${body.slice(0, 180)}`);
      const chunks = [];
      let okCode = false;
      for (const ln of body.split(/\r?\n/).filter(Boolean)) {
        const obj = JSON.parse(ln);
        if (obj.data) chunks.push(Buffer.from(obj.data, 'base64'));
        if (obj.code === 20000000) okCode = true;
        if (obj.code && obj.code !== 0 && obj.code !== 20000000) {
          throw new Error(`API code ${obj.code}: ${obj.message}`);
        }
      }
      const mp3 = Buffer.concat(chunks);
      if (mp3.length < 400 || !okCode) throw new Error(`Empty/incomplete audio (${mp3.length}B)`);
      fs.writeFileSync(outPath, mp3);
      return mp3.length;
    } catch (err) {
      if (attempt === 3) throw err;
      await new Promise(r => setTimeout(r, 700 * attempt));
    }
  }
}

async function main() {
  const dry = process.argv.includes('--dry');
  const files = fs.readdirSync(LESSONS_DIR).filter(f => /^k[1-6][ab]-.*\.html$/i.test(f)).sort();
  const master = new Map();

  for (const f of files) {
    const html = fs.readFileSync(path.join(LESSONS_DIR, f), 'utf8');
    const lines = extractLinesFromHtml(html, f);
    console.log(`[scan] ${f.padEnd(18)} -> ${lines.size} lines`);
    for (const [k, v] of lines) {
      if (!master.has(k)) master.set(k, v);
    }
  }

  console.log(`\nTotal unique normalized voice clips: ${master.size}`);
  if (dry) {
    const sample = [...master.values()].slice(0, 20);
    console.log('\nSample 20 lines:');
    sample.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
    return;
  }

  const apiKey = process.env.DOUBAO_API_KEY;
  if (!apiKey) {
    console.error('ERROR: 请通过环境变量设置 DOUBAO_API_KEY 后再运行合成！');
    process.exit(1);
  }

  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const entries = [...master.entries()].map(([norm, text]) => ({
    norm,
    text,
    file: hashKey(norm)
  }));

  const todo = entries.filter(e => !fs.existsSync(path.join(AUDIO_DIR, e.file)));
  console.log(`Already cached: ${entries.length - todo.length}, To synthesize: ${todo.length}`);

  let done = 0, failed = 0, totalBytes = 0;
  let idx = 0;
  async function worker() {
    while (idx < todo.length) {
      const cur = todo[idx++];
      const outPath = path.join(AUDIO_DIR, cur.file);
      try {
        const bytes = await synthesizeOne(cur.text, outPath, apiKey);
        totalBytes += bytes;
        done++;
        if (done % 25 === 0 || done === todo.length) {
          console.log(`[tts] ${done}/${todo.length} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);
        }
      } catch (e) {
        failed++;
        console.error(`[FAIL] "${cur.text.slice(0, 40)}": ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Build manifest.js containing ONLY files that actually exist on disk
  const manifest = {};
  let validCount = 0, diskBytes = 0;
  for (const e of entries) {
    const p = path.join(AUDIO_DIR, e.file);
    if (fs.existsSync(p)) {
      manifest[e.norm] = e.file;
      validCount++;
      diskBytes += fs.statSync(p).size;
    }
  }
  const js = `/* Auto-generated by tools/doubao_tts_sync.mjs (${validCount} clips, speaker=${SPEAKER}) */\nwindow.__XK_AUDIO_MAP = ${JSON.stringify(manifest)};\n`;
  fs.writeFileSync(MANIFEST_PATH, js, 'utf8');

  console.log(`\nDONE! validClips=${validCount}/${entries.length} failed=${failed} totalSize=${(diskBytes / 1024 / 1024).toFixed(2)} MB`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
