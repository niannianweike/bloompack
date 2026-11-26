#!/usr/bin/env node
/**
 * 小学科学 3D 活页 · 开源造书工作台（Local Studio Server）
 * 零第三方 npm 依赖，纯 Node.js 原生运行：
 *   node studio/server.mjs  (或 npm run studio)
 * 默认访问：http://127.0.0.1:5199
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadSkillBundle,
  buildPlanPrompts,
  buildLivepagePrompts,
  validateGeneratedHtml
} from './skill_prompt.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const JOBS_DIR = path.join(__dirname, 'jobs');
const BOOKS_REG = path.join(__dirname, 'generated-books.json');
const PORT = Number(process.env.STUDIO_PORT || 5199);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(JOBS_DIR, { recursive: true });

// 读取本地可选 studio/.env（不依赖 dotenv）
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  const out = {};
  if (!fs.existsSync(envPath)) return out;
  for (const ln of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const t = ln.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function getEnv(key, fallback = '') {
  const dot = loadDotEnv();
  return process.env[key] || dot[key] || fallback;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.zip': 'application/zip'
};

function sendJson(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
  res.end(buf);
}

function readJsonBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > limitBytes) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function runCmd(cmd, args, envExtra = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: ROOT,
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(`退出码 ${code}: ${(err || out).slice(0, 400)}`));
    });
    child.on('error', reject);
  });
}

async function callLLM({ baseUrl, model, apiKey, messages, temperature = 0.35, maxTokens = 8192 }) {
  const url = baseUrl || getEnv('LLM_BASE_URL', 'https://api.deepseek.com/v1/chat/completions');
  const mdl = model || getEnv('LLM_MODEL', 'deepseek-chat');
  const key = apiKey || getEnv('LLM_API_KEY', '');
  if (!key) throw new Error('请先填写大模型 API Key（或在 studio/.env 中配置 LLM_API_KEY）');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`
    },
    body: JSON.stringify({
      model: mdl,
      messages,
      temperature,
      max_tokens: maxTokens
    })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${text.slice(0, 320)}`);
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 返回内容为空');
  return content;
}

function stripCodeFences(s) {
  let t = String(s || '').trim();
  const m = t.match(/```(?:html|json)?\s*([\s\S]*?)```/i);
  if (m) t = m[1].trim();
  return t;
}

function readBooksReg() {
  try { return JSON.parse(fs.readFileSync(BOOKS_REG, 'utf8')); } catch { return []; }
}

function upsertBookReg(bookMeta, lessonPlan) {
  const list = readBooksReg();
  let book = list.find(b => b.bookId === bookMeta.bookId);
  if (!book) {
    book = {
      bookId: bookMeta.bookId,
      bookTitle: bookMeta.bookTitle,
      gradeLabel: bookMeta.gradeLabel || bookMeta.bookId,
      updatedAt: new Date().toISOString(),
      lessons: []
    };
    list.push(book);
  }
  book.updatedAt = new Date().toISOString();
  const idx = book.lessons.findIndex(x => x.id === lessonPlan.id);
  const rec = {
    id: lessonPlan.id,
    no: lessonPlan.no,
    page: lessonPlan.page,
    lessonName: lessonPlan.lessonName,
    actTitle: lessonPlan.actTitle,
    desc: lessonPlan.desc,
    url: `/app/lessons/${lessonPlan.id}.html`
  };
  if (idx >= 0) book.lessons[idx] = rec;
  else book.lessons.push(rec);
  fs.writeFileSync(BOOKS_REG, JSON.stringify(list, null, 2), 'utf8');
  return book;
}

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = decodeURIComponent(u.pathname);

    // 1. Studio 首页
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveStaticFile(res, path.join(__dirname, 'index.html'));
    }

    // 2. 挂载主项目静态文件（供即时试玩已生成的活页和 3D 书包）
    if (req.method === 'GET' && pathname.startsWith('/app/')) {
      const rel = pathname.slice('/app/'.length);
      const target = path.resolve(ROOT, rel);
      if (!target.startsWith(ROOT)) return sendJson(res, 403, { error: 'Forbidden' });
      return serveStaticFile(res, target);
    }

    // 3. API: 读取配置与 Skill 加载状态
    if (req.method === 'GET' && pathname === '/api/config') {
      const skill = loadSkillBundle();
      return sendJson(res, 200, {
        skillLoaded: skill.loaded,
        skillName: 'science-livebook-builder',
        defaultBaseUrl: getEnv('LLM_BASE_URL', 'https://api.deepseek.com/v1/chat/completions'),
        defaultModel: getEnv('LLM_MODEL', 'deepseek-chat'),
        hasEnvLlmKey: !!getEnv('LLM_API_KEY'),
        hasEnvDoubaoKey: !!getEnv('DOUBAO_API_KEY'),
        generatedBooks: readBooksReg()
      });
    }

    // 4. API: 流式上传教材 PDF 并用 PyMuPDF 提取目录与逐页文本
    if (req.method === 'POST' && pathname === '/api/upload-pdf') {
      const rawName = decodeURIComponent(req.headers['x-file-name'] || 'textbook.pdf');
      const bookId = String(req.headers['x-book-id'] || 'custom').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'custom';
      const bookTitle = decodeURIComponent(req.headers['x-book-title'] || rawName.replace(/\.pdf$/i, ''));
      const safeFile = `${bookId}_${Date.now()}.pdf`;
      const pdfDest = path.join(UPLOADS_DIR, safeFile);
      const jsonDest = path.join(JOBS_DIR, `${bookId}_extract.json`);

      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(pdfDest);
        req.pipe(ws);
        ws.on('finish', resolve);
        ws.on('error', reject);
        req.on('error', reject);
      });

      const pyScript = path.join(__dirname, 'extract_pdf.py');
      await runCmd('python', [pyScript, pdfDest, jsonDest]);
      const extracted = JSON.parse(fs.readFileSync(jsonDest, 'utf8'));

      return sendJson(res, 200, {
        ok: true,
        bookId,
        bookTitle,
        fileName: rawName,
        totalPages: extracted.totalPages,
        inferredOffset: extracted.inferredOffset,
        tocCount: extracted.toc.length,
        tocPagesCount: extracted.tocPages.length,
        previewPages: extracted.pages.slice(0, 12)
      });
    }

    // 5. API: 调用大模型（DeepSeek 默认）按 Skill 规划 1 对 1 活页清单
    if (req.method === 'POST' && pathname === '/api/plan') {
      const body = await readJsonBody(req);
      const bookId = String(body.bookId || 'custom').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
      const jsonDest = path.join(JOBS_DIR, `${bookId}_extract.json`);
      if (!fs.existsSync(jsonDest)) {
        return sendJson(res, 400, { error: '请先上传教材 PDF 并完成解析！' });
      }
      const extracted = JSON.parse(fs.readFileSync(jsonDest, 'utf8'));
      const prompts = buildPlanPrompts(body.bookTitle || bookId, bookId, extracted);

      const raw = await callLLM({
        baseUrl: body.baseUrl,
        model: body.model,
        apiKey: body.apiKey,
        messages: [
          { role: 'system', content: prompts.system },
          { role: 'user', content: prompts.user }
        ],
        temperature: 0.25,
        maxTokens: 4096
      });

      const plan = JSON.parse(stripCodeFences(raw));
      fs.writeFileSync(path.join(JOBS_DIR, `${bookId}_plan.json`), JSON.stringify(plan, null, 2), 'utf8');
      return sendJson(res, 200, { ok: true, plan });
    }

    // 6. API: 按 Skill 14 条红线生成单张 3D 活页 + 自动静态质检 + 可选豆包配音
    if (req.method === 'POST' && pathname === '/api/generate-lesson') {
      const body = await readJsonBody(req);
      const bookMeta = body.bookMeta || {};
      const lesson = body.lesson || {};
      const bookId = String(bookMeta.bookId || 'custom').replace(/[^a-z0-9_-]/gi, '').toLowerCase();
      const lessonId = String(lesson.id || `${bookId}-01`).replace(/[^a-z0-9_-]/gi, '').toLowerCase();

      // 取对应课本页码上下文
      let pageContext = '';
      const jsonDest = path.join(JOBS_DIR, `${bookId}_extract.json`);
      if (fs.existsSync(jsonDest)) {
        const ex = JSON.parse(fs.readFileSync(jsonDest, 'utf8'));
        const pdfP = (lesson.page || 1) + (ex.inferredOffset || 0);
        const near = (ex.pages || []).filter(p => p.pdfPage >= pdfP - 1 && p.pdfPage <= pdfP + 2);
        pageContext = near.map(p => `[PDF P${p.pdfPage}] ${p.snippet}`).join('\n');
      }

      const prompts = buildLivepagePrompts({ ...bookMeta, bookId }, { ...lesson, id: lessonId }, pageContext);
      const messages = [
        { role: 'system', content: prompts.system },
        { role: 'user', content: prompts.user }
      ];

      let html = stripCodeFences(await callLLM({
        baseUrl: body.baseUrl,
        model: body.model,
        apiKey: body.apiKey,
        messages,
        temperature: 0.35,
        maxTokens: 8192
      }));

      let issues = validateGeneratedHtml(html, bookId);
      let repaired = false;

      // 若首次生成存在语法/拼音/红线缺陷，自动触发 1 次定向修复
      if (issues.length > 0) {
        repaired = true;
        messages.push({ role: 'assistant', content: html });
        messages.push({
          role: 'user',
          content: `你刚生成的 HTML 未通过自动质检，发现以下问题：\n- ${issues.join('\n- ')}\n请立刻修复以上全部问题，重新输出完整、干净的单文件 HTML（从 <!DOCTYPE html> 到 </html>，不要加解释文字）。`
        });
        html = stripCodeFences(await callLLM({
          baseUrl: body.baseUrl,
          model: body.model,
          apiKey: body.apiKey,
          messages,
          temperature: 0.2,
          maxTokens: 8192
        }));
        issues = validateGeneratedHtml(html, bookId);
      }

      const outPath = path.join(ROOT, 'lessons', `${lessonId}.html`);
      fs.writeFileSync(outPath, html, 'utf8');

      // 可选：若提供豆包 API Key，自动增量预合成新增语音台词
      let ttsNote = '未配置豆包 Key（跳过离线配音，将自动回退浏览器朗读）';
      const doubaoKey = body.doubaoApiKey || getEnv('DOUBAO_API_KEY', '');
      if (doubaoKey) {
        try {
          await runCmd('node', [path.join(ROOT, 'tools', 'doubao_tts_sync.mjs')], { DOUBAO_API_KEY: doubaoKey });
          ttsNote = '已完成豆包 Seed-TTS 2.0 离线配音合成';
        } catch (e) {
          ttsNote = '豆包配音调用失败（活页本身已保存）：' + e.message.slice(0, 120);
        }
      }

      const reg = upsertBookReg({ ...bookMeta, bookId }, { ...lesson, id: lessonId });
      return sendJson(res, 200, {
        ok: true,
        lessonId,
        file: `lessons/${lessonId}.html`,
        previewUrl: `/app/lessons/${lessonId}.html`,
        repaired,
        issues,
        ttsNote,
        book: reg
      });
    }

    sendJson(res, 404, { error: 'Not Found' });
  } catch (err) {
    console.error('[studio error]', err);
    sendJson(res, 500, { error: err.message || String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const skill = loadSkillBundle();
  console.log(`\n==================================================`);
  console.log(`  小学科学 3D 活页 · 开源造书工作台已启动`);
  console.log(`  工作台地址 : http://127.0.0.1:${PORT}`);
  console.log(`  书包预览   : http://127.0.0.1:${PORT}/app/index.html`);
  console.log(`  Skill 状态 : ${skill.loaded ? '已加载 science-livebook-builder (14条红线)' : '未找到 Skill 目录'}`);
  console.log(`==================================================\n`);
});
