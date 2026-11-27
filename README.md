# 绽放书包（BloomPack）· 小学科学 3D 离线互动书包

把小学科学课堂活动逐课做成**离线可打开的交互式 3D HTML 活页**：孩子打开网页就能直接动手拖拽、实验、观察、比较，把纸面知识变成可互动的立体实验台。

**[在线演示 · 打开绽放书包](https://niannianweike.top/tools/xiaoxuekexue/)**

> **非商用与版权声明**
> 1. **本仓库采用非商用双许可**：原创软件代码遵循 [PolyForm Noncommercial 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)，原创交互教具内容与离线引导语音遵循 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)，详见 [LICENSE](LICENSE)。**本项目不商用**，仅限个人学习、家庭辅导与非营利教学交流。
> 2. **对应教材版权归原出版社及著作权人所有**。本仓库**不包含、不分发**任何教材原始 PDF、整页扫描图片或全书原文；如需对照原书翻页，请在翻书界面点击「📄 导入原书 PDF」加载您通过正规渠道获取的合法教材（仅存于本机浏览器 IndexedDB，零上传、零分发）。

---

## 快速使用（零安装、全离线）

- **直接打开**：双击总入口 [index.html](index.html)，支持 **3D 书包翻书**、**目录总览**、**搜索与接着学**、**小红花进度记录**以及**本机导入原书 PDF**；也可直接打开 `lessons/` 下任意单课 HTML。
- **全离线运行**：3D 引擎内置在 `vendor/three.min.js`，离线引导语音内置在 `audio/` 与 `vendor/voice.js`，无需外网与后端即可在教室电脑、平板与手机上流畅打开。
- **局域网访问**：在项目根目录运行 `python -m http.server 8000`，浏览器访问 `http://localhost:8000/index.html`。
- **本地造书工作台（Studio）**：运行 `npm run studio`（或 `node studio/server.mjs`）后打开 `http://127.0.0.1:5199`，复制 `studio/.env.example` 为 `studio/.env` 并填入自己的 API Key，即可在本地将合法教材 PDF 拆解规划并生成新的 3D 交互活页与配音。

---

## 目录结构

```text
index.html      3D 书包翻书 + 目录总览双模式总入口
lessons/        原创 3D 交互活页成品（一年级上册 16 张 + 一年级下册 14 张，共 30 张）
audio/          离线预合成引导语音 MP3 与 manifest.js 索引（共 1530 条）
vendor/         three.min.js、voice.js（离线语音）与 pdf.min.js / pdf-book.js（本机 PDF 渲染）
studio/         本地造书工作台（用户自带合法教材与自己的 API Key 本地运行）
tools/          语音合成、PDF 探测与自动化验收脚本
LICENSE         非商用双许可与教材版权归属声明
```

---

## 活页编号规则

`k<年级><册>-<课号>`，例如 `k1a-12` 表示一年级上册第 12 课，`k1b-11` 表示一年级下册第 11 课（`a` = 上册，`b` = 下册）。

---

## 已完成进度（一年级上下册 · 共 30 张 3D 互动活页）

### 一年级上册（16 张活页）

| 活页文件 | 课题 | 动手玩法摘要 |
|---|---|---|
| `lessons/k1a-01.html` | 观察物体 | 天平拖物比轻重、长按测软硬、绿垫比长短 |
| `lessons/k1a-02.html` / `k1a-02-span.html` | 物体的分类 | 颜色/大小/形状分类托盘；3D 小手「一拃」量长短分组 |
| `lessons/k1a-03.html` / `k1a-03-book.html` | 认识常见的材料 | 小锤/滴管/小手/磁铁测 5 种材料；给 3D 课本换材质试翻页喷水 |
| `lessons/k1a-04.html` | 认识金属 | 砂纸打磨光泽、磁铁吸铁、敲击辨声、热水杯观察金属导热 |
| `lessons/k1a-05.html` | 认识我自己 | 1–7 岁成长滑杆看变化，喂食对比人与机器人 |
| `lessons/k1a-06.html` | 动物是生物 | 互动观察蝴蝶反应，对比真实小狗与发条玩具狗 |
| `lessons/k1a-07.html` | 植物是生物 | 浇水、光照观察幼苗生长与睡莲绽放，对比塑料假花 |
| `lessons/k1a-08.html` | 常见的天气 | 3D 庭院切换晴、阴、雨、雪、风实时气象变化 |
| `lessons/k1a-09.html` | 观察天气 | 操控红旗、云量天窗、雨量筒与温度计 4 件气象仪器 |
| `lessons/k1a-10.html` | 天气对我们生活的影响 | 不同天气下为 3D 娃娃搭配服装并观察实时反馈 |
| `lessons/k1a-11.html` | 天气对动植物的影响 | 观察雨天蚯蚓、燕子、含羞草与酷热下植物状态变化 |
| `lessons/k1a-12.html` | 制作会旋转的纸蜻蜓 | 沿裁切与折痕四步手工成型并对比平纸条试飞 |
| `lessons/k1a-13.html` | 改进我的纸蜻蜓 | 调节翼长、翼宽与折尾参数，双机同台松手竞飞 |
| `lessons/k1a-14.html` | 发现常见工具的作用 | 对比手撕、小刀划、剪刀剪并用 5× 放大镜观察切口 |

### 一年级下册（14 张活页）

| 活页文件 | 课题 | 动手玩法摘要 |
|---|---|---|
| `lessons/k1b-01.html` | 描述位置 | 教室 3D 方位认知与蒙眼摸旗定向互动 |
| `lessons/k1b-02.html` | 辨别方向 | 太阳辨向与东西南北朝向联动闯关 |
| `lessons/k1b-03.html` | 制作校园模型 | 根据方位线索拼搭 3D 校园模型工坊 |
| `lessons/k1b-04.html` | 身边的植物 | 常见身边植物 3D 认辨观察台 |
| `lessons/k1b-05.html` | 观察植物 | 桌面 3D 工具多角度细致观察月季植株 |
| `lessons/k1b-06.html` | 常见的动物 | 常见动物 3D 特征观察与互动台 |
| `lessons/k1b-07.html` | 动植物的异同 | 动物、植物与非生物综合鉴别分类台 |
| `lessons/k1b-08.html` / `k1b-08-bio.html` | 白天与黑夜 | 24 小时日月东升西落全景；昼夜生物作息对比剧场 |
| `lessons/k1b-09.html` | 天空中的太阳 | 观测日影长短方向规律与太阳辨方向 |
| `lessons/k1b-10.html` | 月亮的形状 | 3D 月相周期变化观测站 |
| `lessons/k1b-11.html` | 设计一座纸桥 | 3D 搭桥积木桌结构承重探索 |
| `lessons/k1b-12.html` | 纸桥制作与改进 | 纸张裁剪折叠造型与放硬币承重测试台 |
| `lessons/k1b-13.html` | 创作科普剧 | 3D 桥梁进化科普剧场互动编排 |

---

## 许可协议

- 软件源代码：[PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0/)
- 原创教学内容、文档与语音：[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)
- 完整说明与教材版权声明请参阅根目录 [LICENSE](LICENSE)。
