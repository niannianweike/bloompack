/**
 * Loads our reusable science-livebook-builder Skill & 14 Defect Prevention Rules
 * and builds structured prompts for any OpenAI-compatible LLM (DeepSeek default).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SKILL_DIR = path.resolve(ROOT, '..', '.agents', 'skills', 'science-livebook-builder');

function safeRead(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

export function loadSkillBundle() {
  const skillMd = safeRead(path.join(SKILL_DIR, 'SKILL.md'));
  const checklistMd = safeRead(path.join(SKILL_DIR, 'references', 'defect-checklist.md'));
  const archMd = safeRead(path.join(SKILL_DIR, 'references', 'architecture-spec.md'));
  return { skillMd, checklistMd, archMd, loaded: !!(skillMd && checklistMd) };
}

export function buildPlanPrompts(bookTitle, bookId, extracted) {
  const { skillMd } = loadSkillBundle();
  const sys = `你是小学科学 3D 互动活页教材策划专家。请严格遵循以下工作流标准（仅拆书选型阶段）：
${skillMd.slice(0, 2600)}

【重要输出规则】
1. 必须仅返回合法 JSON 对象（不要用 markdown 代码块包裹），结构为：
{
  "bookTitle": "书名",
  "bookId": "${bookId}",
  "gradeLabel": "如：一年级下册",
  "units": [
    { "key": "u1", "num": "第 1 单元", "name": "单元名", "color": "#d97706" }
  ],
  "lessons": [
    {
      "id": "${bookId}-01",
      "no": 1,
      "unit": "u1",
      "page": 4,
      "lessonName": "课题名",
      "actTitle": "3D 活页标题（4-10字）",
      "desc": "一句话直接动手玩法（12-26字）",
      "skip": false,
      "skipReason": "",
      "stamps": ["印章1", "印章2", "印章3"],
      "conclusion": "1-2句儿童可懂的科学小结论",
      "quiz": {
        "question": "通关后1道巩固选择题",
        "options": ["选项A", "选项B", "选项C"],
        "correctIndex": 0
      }
    }
  ]
}
2. 严守 1 对 1 原则，每张活页必须是真正适合 3D 视觉/物理/动画/声学交互的动手实验；对纯触感摸物或纯口头讨论页，可标 "skip": true 并写明 skipReason。
3. 控制整本推荐活页数量在 8–18 张之间，优先每课挑出最核心、最好玩的 1 个 3D 实验。`;

  const tocPart = extracted.toc?.length
    ? 'PDF 书签目录：\n' + JSON.stringify(extracted.toc.slice(0, 50))
    : '识别到的目录页正文：\n' + (extracted.tocPages || []).map(p => `[PDF P${p.pdfPage}] ${p.text}`).join('\n');

  const pageSummary = (extracted.pages || [])
    .filter(p => p.charCount > 15)
    .slice(0, 85)
    .map(p => `[PDF第${p.pdfPage}页 / 约正文P${Math.max(1, p.pdfPage - (extracted.inferredOffset || 0))}] ${p.snippet.slice(0, 150)}`)
    .join('\n');

  const user = `教材名称：${bookTitle}
教材编号：${bookId}
总页数：${extracted.totalPages}，推断正文起始偏移：${extracted.inferredOffset}

${tocPart}

各页摘要：
${pageSummary}

请输出符合上述 JSON Schema 的活页规划清单。`;

  return { system: sys, user };
}

export function buildLivepagePrompts(bookMeta, lessonPlan, pageContext) {
  const { checklistMd, archMd } = loadSkillBundle();
  const sys = `你是顶级 Three.js r147 离线儿童科学 3D 互动活页工程师。
你必须严格遵守以下全部技术架构规范和 14 条通病防复发红线（D1–D8 & U1–U6）：

=== 架构规范 ===
${archMd.slice(0, 3200)}

=== 14 条质量红线（全部必须满足） ===
${checklistMd.slice(0, 3400)}

【硬性代码约束（违反即判失败）】
1. 仅输出一个完整可独立运行的单文件 HTML（从 <!DOCTYPE html> 到 </html>），不要输出额外解释文字或 markdown 围栏。
2. 必须且只能加载本地经典脚本：
   <script src="../vendor/three.min.js"></script>
   <script src="../audio/manifest.js"></script>
   <script src="../vendor/voice.js"></script>
   严禁任何 https:// / http:// 外链，严禁 type="module" 和 import 语句！
3. Three.js r147 严禁在 MeshToonMaterial 场景设置 renderer.outputEncoding = THREE.sRGBEncoding；必须钳位 dt = Math.max(0.001, Math.min(0.05, ...))。
4. 必须包含：
   - 左上返回按钮 <a href="../index.html">；
   - 顶部中央动态分步小助手 #guideBar（阶段完成自动切换并语音引导下一步）；
   - 右上 🔊 语音（带顶部微标签“点我听玩法”）、▶ 演示（带顶部微标签“不会玩点演示”）、↺ 重来、拼音 按钮；
   - 右上可收起窄版 #notes（width:228px，#ntList max-height:150px; overflow-y:auto），且右上角 3D 道具避让 #notes 绝不遮挡；
   - 严格通关判定 celebrated = false（仅全部印章集齐后触发一次，resetAll 重置）→ 彩带勋章弹窗含「✨ 科学小结论」+ 1道「💡 考考你」巩固选择题 + saveProgress('${lessonPlan.id}', true) 写入 localStorage['xk_${bookMeta.bookId}_progress']；
   - 语音函数 speak(text, force) 优先调用 window.__xkVoice.speak(text)，静音/重来调用 window.__xkVoice.stop()；
   - 暴露 window.__lesson = { pyErrors, info: () => ({ triangles: renderer.info.render.triangles, celebrated }) }；
   - 严守拼音字音精确对应：不要给长句子写容易数错的 data-py，仅给简短标题/印章写准确 data-py，保证 pyErrors.length === 0！`;

  const user = `请为以下课本活动生成完整的 3D 互动活页 HTML：
- 所属教材：${bookMeta.bookTitle}（${bookMeta.gradeLabel || bookMeta.bookId}）
- 活页文件 ID：${lessonPlan.id}
- 课题：第 ${lessonPlan.no} 课《${lessonPlan.lessonName}》（课本第 ${lessonPlan.page} 页）
- 活页标题：${lessonPlan.actTitle}
- 核心 3D 动手玩法：${lessonPlan.desc}
- 必须达成的印章（全部达成才算通关）：${JSON.stringify(lessonPlan.stamps || ['探索', '对比', '发现'])}
- 通关科学小结论：${lessonPlan.conclusion}
- 通关 1 题巩固选择题：${JSON.stringify(lessonPlan.quiz)}

参考课本原文片段：
${pageContext || '（请紧扣上述课题与小学科学课标设计直观逼真的 3D 桌面实验道具）'}

请直接输出完整单文件 HTML（从 <!DOCTYPE html> 开始）。`;

  return { system: sys, user };
}

export function validateGeneratedHtml(html, bookId) {
  const issues = [];
  if (!/<!doctype\s+html/i.test(html) || !/<\/html>/i.test(html)) {
    issues.push('缺少完整的 HTML 文档结构');
  }
  if (/https?:\/\//i.test(html)) issues.push('包含禁止的 http/https 外链');
  if (/type\s*=\s*["']module["']/i.test(html)) issues.push('包含禁止的 type="module"');
  if (!/\.\.\/vendor\/three\.min\.js/.test(html)) issues.push('缺少 ../vendor/three.min.js');
  if (!/\.\.\/vendor\/voice\.js/.test(html)) issues.push('缺少 ../vendor/voice.js');
  if (/MeshToonMaterial/.test(html) && /outputEncoding\s*=\s*THREE\.sRGBEncoding/.test(html)) {
    issues.push('MeshToonMaterial 违规设置了 sRGBEncoding');
  }
  if (!/id=["']guideBar["']/.test(html)) issues.push('缺少顶部引导栏 #guideBar');
  if (!/celebrated/.test(html)) issues.push('缺少 celebrated 防重复弹窗锁');
  if (!/window\.__lesson/.test(html)) issues.push('缺少 window.__lesson 验收接口');
  if (!new RegExp(`xk_${bookId}_progress|xk_k1a_progress`).test(html)) {
    issues.push('缺少小红花进度写入 saveProgress');
  }

  // JS 语法检查
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)];
  if (scripts.length === 0) {
    issues.push('未找到内联 <script> 脚本');
  } else {
    for (let i = 0; i < scripts.length; i++) {
      try {
        new Function(scripts[i][1]);
      } catch (e) {
        issues.push(`内联脚本 #${i + 1} 语法错误: ${e.message}`);
      }
    }
  }

  // 检查 data-py 汉字数与拼音音节数一致
  for (const m of html.matchAll(/data-py="([^"]+)"[^>]*>([^<]+)</g)) {
    const syl = m[1].trim().split(/\s+/).filter(Boolean).length;
    const han = (m[2].match(/[\u3400-\u9fff]/g) || []).length;
    if (han > 0 && syl !== han) {
      issues.push(`拼音音节数不匹配: "${m[2].trim()}" (${han}字 vs ${syl}音节)`);
    }
  }

  return issues;
}
