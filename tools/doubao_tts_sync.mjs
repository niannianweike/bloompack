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
    /\b(?:WELCOME_TXT|INTRO_VOICE|GUIDE_TEXT|CONCL_SPEECH|CONCL_VOICE|CONCLUSION_TEXT|curGuideSpeech|currentGuideSpeech|guideSpeech|sp|spoken|okText|tip|fb\.textContent|msg)\s*=\s*(['"])((?:\\.|(?!\1).)+?)\1/g,
    /\b(?:voice|speakText|shortNext|skyAnn|spoken|speech|say|hint|tip|ok|bad|wrong|concl|text|explain|sayOk|sayBad|narration|guide|line)\s*:\s*(['"])((?:\\.|(?!\1).)+?)\1/g,
    /\bdiscover\s*\([\s\S]{0,260}?,\s*(['"])((?:\\.|(?!\1).)+?)\1\s*(?:,\s*(?:true|false))?\s*\)/g,
    // Catch discover(id, cat, '无标点中文短句', 'pinyin', ...) used by k1a-03-book/05/06/11/12/13/14
    /\bdiscover\s*\(\s*[^,\n]+,\s*['"][^'"]+['"]\s*,\s*(['"])((?:\\.|(?!\1).){3,80}?)\1/g,
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
  if (fname === 'k1a-01.html') {
    const items = [
      { name: '粉笔', mass: 10, soft: 0, len: 0.80 },
      { name: '橡皮', mass: 15, soft: 0.34, len: 0.50 },
      { name: '黑板擦', mass: 60, soft: 0.17, len: 1.05 },
      { name: '铅笔', mass: 6, soft: 0, len: 1.70 },
      { name: '尺子', mass: 22, soft: 0, len: 1.60 },
      { name: '文具盒', mass: 120, soft: 0.03, len: 1.80 }
    ];
    for (const o of items) {
      add(o.name + (o.soft > 0.08 ? '按起来软软的' : '按起来硬硬的'));
    }
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const light = a.mass < b.mass ? a : b, heavy = a.mass < b.mass ? b : a;
        add(`${light.name}比${heavy.name}轻`);
        const longer = a.len > b.len ? a : b, shorter = a.len > b.len ? b : a;
        add(`${longer.name}比${shorter.name}长`);
        const sa = a.soft > 0.08 ? a.soft : 0, sb = b.soft > 0.08 ? b.soft : 0;
        if (sa === 0 && sb === 0) {
          add(`${a.name}和${b.name}都很硬`);
          add(`${b.name}和${a.name}都很硬`);
        } else if (sa !== sb) {
          const s1 = sa > sb ? a : b, s2 = sa > sb ? b : a;
          add(`${s1.name}比${s2.name}软`);
        }
      }
    }
  }
  if (fname === 'k1a-02-span.html') {
    const items = [
      ['橡皮', '比一拃短'], ['粉笔', '比一拃短'],
      ['水彩笔', '正好一拃'], ['铅笔', '正好一拃'],
      ['尺子', '比一拃长'], ['毛笔', '比一拃长']
    ];
    for (const [name, lab] of items) {
      add(`${name}${lab}！快把它拖进右边${lab}的木格里吧！`);
      add(`${name}${lab}，放对啦！`);
      add(`先在绿垫子上用一拃量一量，${name}${lab}哦`);
    }
    for (let rem = 1; rem <= 5; rem++) {
      add(`还剩${rem}件文具没量哦，拖到左边绿垫子上量一量吧！`);
    }
  }
  if (fname === 'k1a-02.html') {
    const modeBins = [
      ['颜色', ['红', '黄', '蓝']],
      ['大小', ['大', '中', '小']],
      ['形状', ['长方', '圆柱', '圆球']]
    ];
    for (const [mName, bins] of modeBins) {
      for (const lbl of bins) {
        add(`这是${lbl}盘`);
        add(`放进${lbl}盘试试吧`);
        add(`按${mName}分出${lbl}啦，继续把剩下的积木分完吧`);
      }
    }
  }
  if (fname === 'k1a-03.html') {
    const mats = [
      ['木块', '敲着咚咚响', '吸水慢', '很坚硬', false],
      ['塑料片', '敲着咔哒响', '不吸水', '能弯有弹性', false],
      ['棉布', '敲起来闷闷的', '会吸水', '很柔软', false],
      ['金属勺', '敲起来很清脆', '不吸水', '掰不动很硬', true],
      ['纸张', '敲着沙沙响', '会吸水', '很容易弯折', false]
    ];
    for (const [name, snd, wat, bend, mag] of mats) {
      add(name + snd);
      add(name + wat);
      add(name + bend);
      add(name + (mag ? '能被磁铁吸住' : '不能被磁铁吸住'));
    }
  }
  if (fname === 'k1a-03-book.html') {
    for (const m of ['木板', '铁板', '布', '玻璃']) {
      add(`换成${m}课本啦！`);
    }
    for (const df of ['纸书轻便最好翻', '木书太厚又太硬', '铁书太沉翻不动', '布书太软塌下去', '玻璃书一翻容易碎']) {
      add(df);
    }
  }
  if (fname === 'k1a-04.html') {
    const rods = [
      ['铜丝', true, false],
      ['铁勺', true, true],
      ['铝尺', true, false],
      ['木棍', false, false],
      ['塑料尺', false, false]
    ];
    for (const [name, metal, mag] of rods) {
      add(name + (metal ? '有金属光泽' : '没有金属光泽'));
      add(mag ? '铁勺能被磁铁吸住' : (name + '不被磁铁吸'));
      add(name + (metal ? '敲击很清脆' : '敲击很沉闷'));
      add(name + (metal ? '传热非常快' : '传热非常慢'));
    }
  }
  if (fname === 'k1a-13.html') {
    add('太棒啦！改进款比上节课款留空更久，飞翼更长更宽、空气阻力更大，稳稳拿到冠军！');
    add('改进款落得更快！因为飞翼面积还不够大，想让它落得更慢更稳，试着把飞翼长度往右拉长、飞翼宽度往右拉宽，再试飞一次！');
    add('改进款落得更快！因为飞翼偏短，想让它落得更慢更稳，试着把飞翼长度往右拉长，再试飞一次！');
    add('改进款落得更快！因为飞翼偏窄，想让它落得更慢更稳，试着把飞翼宽度往右拉宽，再试飞一次！');
    add('改进款落得更快！因为尾巴太重，想让它落得更慢更稳，试着把折尾重量调到适中，再试飞一次！');
    add('改进款落得更快！因为尾巴太轻会摇晃，想让它落得更慢更稳，试着把折尾重量调到适中，再试飞一次！');
    add('改进款落得更快！想让它落得更慢更稳，试着把飞翼长度往右拉长、飞翼宽度往右拉宽、折尾重量调到适中，再试飞一次！');
  }
  if (fname === 'k1b-02.html') {
    const dirs = [
      ['东', '东', '西', '北', '南'],
      ['北', '北', '南', '西', '东'],
      ['西', '西', '东', '南', '北'],
      ['南', '南', '北', '东', '西']
    ];
    for (const [face, f, b, l, r] of dirs) {
      add(`顺着楼梯走下一楼啦！现在面向${face}面：前${f}、后${b}、左${l}、右${r}！`);
      add(`现在在二楼面向${face}面！前面是${f}，后面是${b}，左面是${l}，右面是${r}！`);
      add(`转向面向${face}面啦！现在前${f}、后${b}、左${l}、右${r}！`);
      add(`原地转身面向${face}面啦！现在前${f}、后${b}、左${l}、右${r}！`);
    }
  }
  if (fname === 'k1b-07.html') {
    for (const nm of ['海马', '大熊猫', '飞鸟', '猪笼草', '松树', '小麦', '铜奔马', '紫水晶']) {
      add(`这是${nm}！看看它头顶的特征徽章，拖进后方对应木盘吧！`);
    }
  }
  if (fname === 'k1b-09.html') {
    const slots = [
      ['早上8时', '东方', '西方很长'],
      ['上午10时', '东南方', '西北方变短'],
      ['中午12时', '正南方最高处', '正北方最短'],
      ['下午2时', '西南方', '东北方变长'],
      ['下午4时', '西方', '东方很长']
    ];
    for (const [lb, d, sd] of slots) {
      add(`${lb}，太阳在${d}，地面旗杆的影子指向${sd}！`);
      add(`快看旗杆的影子！太阳在${d}，影子永远朝相反的${sd}！`);
    }
    for (const [rk, ans] of [['身后', '西'], ['左手边', '北'], ['右手边', '南']]) {
      add(`${rk}已经贴对是${ans}啦！`);
      add(`现在来贴【${rk}】的方位牌，从气泡里选出正确方向吧！`);
    }
    add('贴对啦！面向东方太阳，身后贴好啦！接下来再贴【左手边】的方位牌吧！');
    add('贴对啦！面向东方太阳，左手边贴好啦！接下来再贴【右手边】的方位牌吧！');
  }
  if (fname === 'k1b-10.html') {
    const mps = [
      ['初三', '蛾眉月'], ['初八', '上弦月'], ['十五', '满月'], ['廿二', '下弦月'], ['廿七', '残月']
    ];
    for (const [lu, nm] of mps) {
      add(`滑到农历${lu}${nm}啦！点右下角望远镜咔嚓拍下来吧！`);
      add(`转到农历${lu}${nm}啦，点右下角望远镜咔嚓拍下来贴进黑卡纸吧！`);
    }
  }
  if (fname === 'k1b-11.html') {
    for (const nm of ['纸桥墩', '主梁和胶带', '平纸桥面', '凹槽桥面', '波浪瓦楞桥面']) {
      add(`把${nm}拆回左侧蓝图板啦，可以随时重新搭配！`);
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
