# 3D 互动课本 · 公众号 GIF 与高清静帧通用采集指南

> 工具落盘：`D:\aijiaoyu\xiaoxuekexue\tools\capture_gif.py`  
> 首篇范例配置：`D:\aijiaoyu\xiaoxuekexue\tools\gifs_first_issue.json`

本工具采用 **本地静态 HTTP + Playwright Chromium (WebGL) + CDP 无损 PNG 截帧 + FFmpeg 两步调色板法**，专为公众号图文自动录制高清晰度、严格通过微信体积与帧数门禁的 3D 教具动图与静态兜底图。

---

## 一、核心优势与硬红线

1. **零加载白屏**：先等页面 `networkidle` + WebGL Canvas 渲染稳定 `1.5s`，再执行完 `setup` 录前准备动作后才启动 CDP `Page.startScreencast` 截帧。
2. **零二次有损模糊**：直接采集无损 960×600 PNG 帧序列，按真实时间戳重采样为均匀帧率（支持 `target_duration_s` 自动抵消 SwiftShader 软件渲染慢放），再直入 FFmpeg 两步调色板法：
   - `palettegen=max_colors=256:stats_mode=diff`
   - `paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`
3. **微信公众平台硬门禁自动兜底**：自动检查单张 GIF 体积 `< 5.0 MB` 且总帧数 `< 300 帧`；若超标自动沿 `720px/14fps → 640px/14fps → 640px/12fps → 600px/12fps → ...` 阶梯降档重试直到达标。
4. **版权红线物理拦截**：默认开启 `block_textbook_scans: true`，自动拦截 `/pages/` 与 `.pdf` 请求，结构上杜绝误录任何原始教材扫描页。
5. **一录三得**：每条分镜自动同步输出 `*.gif`（公众号动图）、`*.png`（960×600 高清静帧兜底图），并在输出目录自动生成 `capture_report.json` 与离线循环预览墙 `gif_preview_wall.html`。

---

## 二、快速复用到任意新课（3 步出片）

### 第 1 步：确认页面真实选择器与 3D 坐标钩子
录制新课前先读对应 `lessons/xxx.html` 源码确认：
- DOM 按钮 / 滑块 ID（如 `#pyBtn`、`#inLen`、`#hourSlider`、`#xrayBtn`、`#launchBtn`、`#ntTog`）；
- 3D 对象屏幕坐标钩子（本库绝大多数活页已内置 `window.__lesson.getTargets()` / `window.__lesson.targets()` / `window.__lesson.info().targets`；主书包内置 `window.__hubSpine(i)` 与 `window.__hubFlyT()`）。

### 第 2 步：编写 JSON 分镜清单
复制 `tools/gifs_first_issue.json` 为新期配置文件（如 `tools/gifs_issue02.json`），按需组合以下动作原语：

| `type` | 作用 | 常用参数 |
|:--|:--|:--|
| `wait` | 静默等待 / 定格展示 | `ms` |
| `wait_until` | 等到某个 JS 条件成立再继续（防不同电脑帧率漂移） | `js`, `timeout_ms` |
| `hover` | 平滑移动模拟光标悬停 | `target`, `duration_ms`, `steps` |
| `click` | 移到目标并点击（自带淡淡橙白点击涟漪） | `target`, `move_ms`, `after_ms` |
| `smooth_drag` | 分步平滑拖拽 3D 物体（支持 `waypoints` 与二次贝塞尔 `curve: true`） | `waypoints` 或 `from`/`to`, `steps`, `duration_ms`, `curve` |
| `slider_drag` | 平滑拖动 `<input type="range">` 滑块并同步派发 `input`/`change` | `selector`, `from_value`, `to_value`, `steps`, `duration_ms` |
| `smooth_sweep` | 连续平滑扫过多个目标点（如 12 册书脊波浪） | `waypoints`, `steps`, `duration_ms`, `highlight_at` |
| `drag_circle` | 围绕中心点画圈拖动（如拧橡皮筋小车竹棒） | `start_target`, `center_target`, `radius`, `turns`, `until_js` |
| `highlight` | 立即捕获当前帧为高清 960×600 PNG 静帧兜底图 | `hide_cursor` |
| `hide_cursor` | 隐藏模拟光标（适合动画自动播放和定格阶段） | — |
| `eval` | 执行少量准备 JS（如初始重置某状态） | `code` |

> `target` 统一支持三种写法：
> - CSS 选择器字符串：`"#launchBtn"`
> - 带偏移对象：`{"selector": "#btn", "rx": 0.5, "ry": 0.5, "dx": 0, "dy": 0}`
> - 3D 投影 JS 表达式：`{"js": "window.__lesson.getTargets().sun", "dx": 0, "dy": 0}`
> - 绝对像素坐标：`[480, 300]`

### 第 3 步：一键批量录制与单条重录

```powershell
# 批量录制整份配置并生成离线预览墙
python D:\aijiaoyu\xiaoxuekexue\tools\capture_gif.py `
  --config D:\aijiaoyu\xiaoxuekexue\tools\gifs_first_issue.json `
  --out-dir "D:\aijiaoyu\510-教育IP内容生产\账号包-AI教育IP\02-生产\你的文章目录\素材\gifs"

# 仅微调重录其中 1–2 条（会自动保留其余条目并刷新预览墙）
python D:\aijiaoyu\xiaoxuekexue\tools\capture_gif.py `
  --config D:\aijiaoyu\xiaoxuekexue\tools\gifs_first_issue.json `
  --out-dir "D:\aijiaoyu\...\素材\gifs" `
  --only gif03_day_night gif06_rubber_car
```

---

## 三、常见避坑清单

1. **避免通关弹窗遮挡定格画面**：默认 `hide_win_modal: true` 会自动隐藏 `#winToast`，保留彩带和 3D 场景完整可见。
2. **避免 960px 窄屏下右上角发现栏遮挡场景**：若右上角 `#notes` 遮住重要 3D 区域（如小车终点跑道或微观放大镜），在 `setup` 第一行加 `{"type": "click", "target": "#ntTog", "move_ms": 0}` 收起即可。
3. **避免软件渲染导致的慢放漂移**：给每条分镜设置 `"target_duration_s": 5.5`（通常 4.5–6.0s），重采样器会把捕获到的真实时间轴丝滑映射回 1.0x 原生流畅节奏，同时精准锁定帧数（如 5.6s × 14fps = 78 帧）。
4. **验收必看**：打开输出目录里的 `gif_preview_wall.html` 逐条检查流畅度、循环衔接、中文/拼音清晰度与体积/帧数门禁。
