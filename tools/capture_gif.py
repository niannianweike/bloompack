#!/usr/bin/env python3
"""
通用 3D 互动课本动图（GIF）与高清静帧自动采集工具
================================================
特性：
1. 内置本地静态 HTTP 服务器托管 xiaoxuekexue/（不走外网），默认拦截教材原页扫描图（/pages/ 与 .pdf）。
2. Playwright Chromium（默认 960x600，WebGL + SwiftShader 兼容），支持等待 Canvas 渲染稳定后起录，彻底切掉加载白屏。
3. 使用 CDP Page.startScreencast 采集无损 PNG 帧序列，再按真实时间戳重采样为均匀帧率，避免 WebM 二次有损压缩模糊。
4. 数据驱动 JSON 动作清单：支持 setup（录前准备）与 actions（录中操作），内置 hover / click / smooth_drag / slider_drag / smooth_sweep / drag_circle / wait / highlight / eval，并可选渲染柔和模拟光标与点击涟漪。
5. 调用 ffmpeg 两步调色板法（palettegen=stats_mode=diff + paletteuse=dither=bayer:bayer_scale=3）转成公众号专用 GIF，自动执行微信门禁（< 5MB 且 < 300 帧），超标自动降档重试直到全部达标。
6. 每条 GIF 自动导出 1 张最高光时刻 960x600 高清 PNG 静态兜底图，并输出实测验收报告与离线 HTML 预览墙。

用法示例：
  python tools/capture_gif.py --config tools/gifs_first_issue.json --out-dir <输出目录>
  python tools/capture_gif.py --config tools/gifs_first_issue.json --out-dir <输出目录> --only gif01_bag_wave
"""

import argparse
import base64
import functools
import http.server
import json
import math
import os
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image
from playwright.sync_api import Page, sync_playwright


# ---------- 缓动与插值函数 ----------

def ease_in_out_cubic(t: float) -> float:
    t = max(0.0, min(1.0, t))
    if t < 0.5:
        return 4.0 * t * t * t
    return 1.0 - pow(-2.0 * t + 2.0, 3) / 2.0


def eval_quad_bezier(p0: Tuple[float, float], p1: Tuple[float, float], p2: Tuple[float, float], t: float) -> Tuple[float, float]:
    u = 1.0 - t
    x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0]
    y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1]
    return (x, y)


def sample_polyline(points: List[Tuple[float, float]], t: float, curve: bool = False) -> Tuple[float, float]:
    if not points:
        return (0.0, 0.0)
    if len(points) == 1:
        return points[0]
    t = max(0.0, min(1.0, t))
    if curve and len(points) == 3:
        return eval_quad_bezier(points[0], points[1], points[2], t)
    # 分段弧长匀速插值
    segs = []
    total = 0.0
    for i in range(len(points) - 1):
        dx = points[i + 1][0] - points[i][0]
        dy = points[i + 1][1] - points[i][1]
        d = math.hypot(dx, dy)
        segs.append(d)
        total += d
    if total <= 1e-6:
        return points[-1]
    target = t * total
    acc = 0.0
    for i, d in enumerate(segs):
        if acc + d >= target or i == len(segs) - 1:
            local_t = (target - acc) / max(d, 1e-6)
            local_t = max(0.0, min(1.0, local_t))
            x = points[i][0] + (points[i + 1][0] - points[i][0]) * local_t
            y = points[i][1] + (points[i + 1][1] - points[i][1]) * local_t
            return (x, y)
        acc += d
    return points[-1]


# ---------- 本地静态 HTTP 服务器 ----------

class QuietHTTPHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True


def start_local_server(root_dir: Path) -> Tuple[ThreadedTCPServer, int]:
    handler = functools.partial(QuietHTTPHandler, directory=str(root_dir))
    srv = ThreadedTCPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, port


# ---------- 模拟鼠标光标层注入 ----------

CURSOR_INIT_JS = r"""
(() => {
  if (document.getElementById('__cap_cursor_style')) return;
  const style = document.createElement('style');
  style.id = '__cap_cursor_style';
  style.textContent = `
    #__cap_cursor {
      position: fixed;
      left: -100px;
      top: -100px;
      width: 24px;
      height: 24px;
      margin-left: -12px;
      margin-top: -12px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.95) 0%, rgba(255,154,60,0.72) 58%, rgba(229,109,23,0.42) 100%);
      border: 2.5px solid rgba(255,255,255,0.95);
      box-shadow: 0 2px 10px rgba(36,24,10,0.34), 0 0 0 3px rgba(229,109,23,0.22);
      pointer-events: none;
      z-index: 2147483646;
      opacity: 0;
      transform: scale(1);
      transition: transform 0.10s ease, opacity 0.16s ease, box-shadow 0.12s ease;
    }
    #__cap_cursor.vis { opacity: 1; }
    #__cap_cursor.down {
      transform: scale(0.82);
      box-shadow: 0 1px 6px rgba(36,24,10,0.40), 0 0 0 7px rgba(245,158,11,0.38);
      background: radial-gradient(circle at 35% 35%, rgba(255,255,255,0.98) 0%, rgba(245,158,11,0.92) 62%, rgba(229,109,23,0.68) 100%);
    }
    .__cap_ripple {
      position: fixed;
      width: 18px;
      height: 18px;
      margin-left: -9px;
      margin-top: -9px;
      border-radius: 50%;
      border: 2.5px solid rgba(255,154,60,0.92);
      background: rgba(255,237,213,0.30);
      pointer-events: none;
      z-index: 2147483645;
      animation: __capRipple 0.42s ease-out forwards;
    }
    @keyframes __capRipple {
      0%   { transform: scale(0.7); opacity: 0.95; }
      100% { transform: scale(2.8); opacity: 0; }
    }
  `;
  document.head.appendChild(style);
  const dot = document.createElement('div');
  dot.id = '__cap_cursor';
  document.body.appendChild(dot);

  window.__capCursor = {
    enabled: true,
    move(x, y) {
      if (!this.enabled) return;
      dot.style.left = x + 'px';
      dot.style.top = y + 'px';
      dot.classList.add('vis');
    },
    down(x, y) {
      if (!this.enabled) return;
      if (x !== undefined && y !== undefined) this.move(x, y);
      dot.classList.add('down');
    },
    up() {
      dot.classList.remove('down');
    },
    ripple(x, y) {
      if (!this.enabled) return;
      const r = document.createElement('div');
      r.className = '__cap_ripple';
      r.style.left = x + 'px';
      r.style.top = y + 'px';
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 460);
    },
    hide() {
      this.enabled = false;
      dot.classList.remove('vis', 'down');
    },
    show() {
      this.enabled = true;
    }
  };
  // 原生事件监听自动同步真实鼠标轨迹，省去每帧跨进程 RPC 延迟
  window.addEventListener('pointermove', (e) => window.__capCursor.move(e.clientX, e.clientY), true);
  window.addEventListener('pointerdown', (e) => {
    window.__capCursor.down(e.clientX, e.clientY);
    window.__capCursor.ripple(e.clientX, e.clientY);
  }, true);
  window.addEventListener('pointerup', () => window.__capCursor.up(), true);
})();
"""


# ---------- 坐标解析与拟人动作执行器 ----------

class ActionRunner:
    def __init__(self, page: Page, show_cursor: bool = True, raw_frames: Optional[List[Tuple[float, bytes]]] = None):
        self.page = page
        self.show_cursor = show_cursor
        self.cur_x = 480.0
        self.cur_y = 300.0
        self.highlight_bytes: Optional[bytes] = None
        self.raw_frames = raw_frames

    def _capture_highlight_now(self) -> None:
        if self.raw_frames:
            self.highlight_bytes = self.raw_frames[-1][1]
        else:
            self.highlight_bytes = self.page.screenshot(type="png")

    def init_cursor(self) -> None:
        if self.show_cursor:
            self.page.evaluate(CURSOR_INIT_JS)

    def _cursor_enable(self, enabled: bool) -> None:
        if self.show_cursor:
            fn = "show" if enabled else "hide"
            self.page.evaluate(f"() => window.__capCursor && window.__capCursor.{fn}()")

    def _cursor_move(self, x: float, y: float) -> None:
        self.cur_x, self.cur_y = float(x), float(y)
        self.page.mouse.move(self.cur_x, self.cur_y)

    def _cursor_down(self) -> None:
        self.page.mouse.down()

    def _cursor_up(self) -> None:
        self.page.mouse.up()

    def _cursor_hide(self) -> None:
        self._cursor_enable(False)

    def _sleep_until(self, deadline: float) -> None:
        rem = (deadline - time.monotonic()) * 1000.0
        if rem > 3.0:
            self.page.wait_for_timeout(int(rem))

    def resolve_point(self, spec: Any) -> Tuple[float, float]:
        """将 selector / js 表达式 / [x, y] 统一解析为视口像素坐标 (x, y)。"""
        if isinstance(spec, (list, tuple)) and len(spec) == 2:
            return (float(spec[0]), float(spec[1]))
        if isinstance(spec, dict):
            dx = float(spec.get("dx", 0))
            dy = float(spec.get("dy", 0))
            if "pos" in spec:
                px, py = spec["pos"]
                return (float(px) + dx, float(py) + dy)
            if "selector" in spec:
                loc = self.page.locator(spec["selector"]).first
                box = loc.bounding_box()
                if not box:
                    raise RuntimeError(f"找不到元素或其不可见: {spec['selector']}")
                rx = float(spec.get("rx", 0.5))
                ry = float(spec.get("ry", 0.5))
                return (box["x"] + box["width"] * rx + dx, box["y"] + box["height"] * ry + dy)
            if "js" in spec:
                res = self.page.evaluate(f"() => ({spec['js']})")
                if not res or "x" not in res or "y" not in res:
                    raise RuntimeError(f"JS 坐标解析失败: {spec['js']} -> {res}")
                x = res.get("clientX", res["x"])
                y = res.get("clientY", res["y"])
                return (float(x) + dx, float(y) + dy)
        if isinstance(spec, str):
            loc = self.page.locator(spec).first
            box = loc.bounding_box()
            if not box:
                raise RuntimeError(f"找不到元素或其不可见: {spec}")
            return (box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
        raise ValueError(f"无法解析目标点: {spec}")

    def smooth_move_to(self, tx: float, ty: float, duration_ms: int = 240, steps: int = 10) -> None:
        sx, sy = self.cur_x, self.cur_y
        steps = max(2, steps)
        dur_s = max(0.04, duration_ms / 1000.0)
        t0 = time.monotonic()
        for i in range(1, steps + 1):
            u = ease_in_out_cubic(i / steps)
            nx = sx + (tx - sx) * u
            ny = sy + (ty - sy) * u
            self._cursor_move(nx, ny)
            self._sleep_until(t0 + dur_s * (i / steps))

    def run_actions(self, actions: List[Dict[str, Any]], record_mode: bool = True) -> None:
        self._cursor_enable(record_mode)
        for act in actions:
            kind = act["type"]

            if kind == "wait":
                self.page.wait_for_timeout(int(act.get("ms", 500)))

            elif kind == "wait_until":
                expr = act["js"]
                timeout_s = float(act.get("timeout_ms", 3000)) / 1000.0
                t0 = time.monotonic()
                while time.monotonic() - t0 < timeout_s:
                    if self.page.evaluate(f"() => Boolean({expr})"):
                        break
                    self.page.wait_for_timeout(35)

            elif kind == "eval":
                self.page.evaluate(act["code"])

            elif kind == "hide_cursor":
                self._cursor_hide()

            elif kind == "hover":
                if record_mode:
                    self._cursor_enable(True)
                tx, ty = self.resolve_point(act["target"])
                dur = int(act.get("duration_ms", 300))
                steps = int(act.get("steps", 12))
                if act.get("instant"):
                    self._cursor_move(tx, ty)
                else:
                    self.smooth_move_to(tx, ty, dur, steps)
                if act.get("pause_ms"):
                    self.page.wait_for_timeout(int(act["pause_ms"]))

            elif kind == "click":
                if record_mode:
                    self._cursor_enable(True)
                tx, ty = self.resolve_point(act["target"])
                move_ms = int(act.get("move_ms", 200 if record_mode else 0))
                if move_ms > 0:
                    self.smooth_move_to(tx, ty, move_ms, max(4, int(move_ms / 30)))
                else:
                    self._cursor_move(tx, ty)
                self._cursor_down()
                self.page.wait_for_timeout(int(act.get("hold_ms", 55)))
                self._cursor_up()
                if act.get("after_ms"):
                    self.page.wait_for_timeout(int(act["after_ms"]))

            elif kind == "smooth_drag":
                if record_mode:
                    self._cursor_enable(True)
                if "waypoints" in act:
                    pts = [self.resolve_point(w) for w in act["waypoints"]]
                else:
                    pts = [self.resolve_point(act["from"]), self.resolve_point(act["to"])]
                move_ms = int(act.get("move_ms", 180 if record_mode else 0))
                if move_ms > 0:
                    self.smooth_move_to(pts[0][0], pts[0][1], move_ms, max(4, int(move_ms / 30)))
                else:
                    self._cursor_move(pts[0][0], pts[0][1])
                self._cursor_down()
                self.page.wait_for_timeout(40)
                steps = int(act.get("steps", 28))
                dur_s = max(0.1, float(act.get("duration_ms", 1200)) / 1000.0)
                curve = bool(act.get("curve", False))
                linear = bool(act.get("linear", False))
                t0 = time.monotonic()
                for i in range(1, steps + 1):
                    u = (i / steps) if linear else ease_in_out_cubic(i / steps)
                    nx, ny = sample_polyline(pts, u, curve=curve)
                    self._cursor_move(nx, ny)
                    self._sleep_until(t0 + dur_s * (i / steps))
                self.page.wait_for_timeout(35)
                self._cursor_up()
                if act.get("after_ms"):
                    self.page.wait_for_timeout(int(act["after_ms"]))

            elif kind == "slider_drag":
                if record_mode:
                    self._cursor_enable(True)
                sel = act["selector"]
                to_val = float(act["to_value"])
                steps = int(act.get("steps", 16))
                dur_s = max(0.08, float(act.get("duration_ms", 550)) / 1000.0)
                move_ms = int(act.get("move_ms", 160 if record_mode else 0))
                info = self.page.evaluate(
                    """(sel) => {
                      const el = document.querySelector(sel);
                      if (!el) return null;
                      const r = el.getBoundingClientRect();
                      return {
                        left: r.left, top: r.top, width: r.width, height: r.height,
                        min: parseFloat(el.min || '0'),
                        max: parseFloat(el.max || '100'),
                        step: parseFloat(el.step || '1'),
                        val: parseFloat(el.value)
                      };
                    }""",
                    sel,
                )
                if not info:
                    raise RuntimeError(f"找不到滑块: {sel}")
                span = max(1e-6, info["max"] - info["min"])
                from_val = float(act.get("from_value", info["val"]))
                pad = 11.0
                track_w = max(10.0, info["width"] - pad * 2)
                cy = info["top"] + info["height"] * 0.5

                def val_to_x(v: float) -> float:
                    frac = max(0.0, min(1.0, (v - info["min"]) / span))
                    return info["left"] + pad + frac * track_w

                sx = val_to_x(from_val)
                if move_ms > 0:
                    self.smooth_move_to(sx, cy, move_ms, max(4, int(move_ms / 30)))
                else:
                    self._cursor_move(sx, cy)
                self._cursor_down()
                t0 = time.monotonic()
                step_unit = info["step"] if info["step"] > 0 else 0.01
                for i in range(1, steps + 1):
                    u = ease_in_out_cubic(i / steps)
                    cur_v = from_val + (to_val - from_val) * u
                    if step_unit >= 1.0:
                        cur_v = round(cur_v)
                    else:
                        cur_v = round(cur_v / step_unit) * step_unit
                    cx = val_to_x(cur_v)
                    self._cursor_move(cx, cy)
                    self.page.evaluate(
                        """([sel, v]) => {
                          const el = document.querySelector(sel);
                          if (!el) return;
                          el.value = String(v);
                          el.dispatchEvent(new Event('input', { bubbles: true }));
                        }""",
                        [sel, cur_v],
                    )
                    self._sleep_until(t0 + dur_s * (i / steps))
                self.page.evaluate(
                    """(sel) => {
                      const el = document.querySelector(sel);
                      if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
                    }""",
                    sel,
                )
                self._cursor_up()
                if act.get("after_ms"):
                    self.page.wait_for_timeout(int(act["after_ms"]))

            elif kind == "smooth_sweep":
                if record_mode:
                    self._cursor_enable(True)
                pts = [self.resolve_point(w) for w in act["waypoints"]]
                move_ms = int(act.get("move_ms", 120 if record_mode else 0))
                if move_ms > 0:
                    self.smooth_move_to(pts[0][0], pts[0][1], move_ms, max(4, int(move_ms / 30)))
                else:
                    self._cursor_move(pts[0][0], pts[0][1])
                steps = int(act.get("steps", 32))
                dur_s = max(0.2, float(act.get("duration_ms", 1800)) / 1000.0)
                highlight_at = act.get("highlight_at")
                hl_captured = False
                t0 = time.monotonic()
                for i in range(1, steps + 1):
                    u = ease_in_out_cubic(i / steps)
                    nx, ny = sample_polyline(pts, u, curve=False)
                    self._cursor_move(nx, ny)
                    if highlight_at is not None and not hl_captured and (i / steps) >= float(highlight_at):
                        self._capture_highlight_now()
                        hl_captured = True
                    self._sleep_until(t0 + dur_s * (i / steps))
                if act.get("after_ms"):
                    self.page.wait_for_timeout(int(act["after_ms"]))

            elif kind == "drag_circle":
                if record_mode:
                    self._cursor_enable(True)
                start_x, start_y = self.resolve_point(act["start_target"])
                if "center_target" in act:
                    cx, cy = self.resolve_point(act["center_target"])
                else:
                    cx = start_x + float(act.get("center_dx", 0))
                    cy = start_y + float(act.get("center_dy", 34))
                radius = float(act.get("radius", max(28.0, math.hypot(start_x - cx, start_y - cy))))
                turns = float(act.get("turns", 1.8))
                direction = 1.0 if act.get("clockwise", True) else -1.0
                steps = int(act.get("steps", 34))
                dur_s = max(0.2, float(act.get("duration_ms", 1400)) / 1000.0)
                until_js = act.get("until_js")

                move_ms = int(act.get("move_ms", 160 if record_mode else 0))
                if move_ms > 0:
                    self.smooth_move_to(start_x, start_y, move_ms, max(4, int(move_ms / 30)))
                else:
                    self._cursor_move(start_x, start_y)
                self._cursor_down()
                self.page.wait_for_timeout(35)
                a0 = math.atan2(start_y - cy, start_x - cx)
                t0 = time.monotonic()
                for i in range(1, steps + 1):
                    frac = i / steps
                    ang = a0 + direction * turns * 2.0 * math.pi * frac
                    nx = cx + math.cos(ang) * radius
                    ny = cy + math.sin(ang) * radius
                    self._cursor_move(nx, ny)
                    self._sleep_until(t0 + dur_s * frac)
                    if until_js and self.page.evaluate(f"() => Boolean({until_js})"):
                        break
                self.page.wait_for_timeout(40)
                self._cursor_up()
                if act.get("after_ms"):
                    self.page.wait_for_timeout(int(act["after_ms"]))

            elif kind == "highlight":
                hide_for_png = bool(act.get("hide_cursor", True))
                if hide_for_png:
                    self._cursor_hide()
                    self.page.wait_for_timeout(60)
                self._capture_highlight_now()

            else:
                raise ValueError(f"未知动作类型: {kind}")


# ---------- 无损帧重采样 + FFmpeg 两步调色板转 GIF + 微信门禁自动降档 ----------

def resample_frames_to_cfr(
    raw_frames: List[Tuple[float, bytes]],
    t_start: float,
    t_end: float,
    fps: int,
    out_dir: Path,
    target_duration_s: Optional[float] = None,
) -> int:
    """按真实时间戳重采样为均匀帧率 PNG 序列（支持 target_duration_s 校准软件渲染慢放）。"""
    if not raw_frames:
        raise RuntimeError("未采集到任何视频帧！")
    raw_frames.sort(key=lambda item: item[0])
    raw_duration = max(0.5, t_end - t_start)
    out_duration = float(target_duration_s) if (target_duration_s and target_duration_s > 0.5) else raw_duration
    n_slots = max(2, int(round(out_duration * fps)))
    idx = 0
    total_raw = len(raw_frames)
    for k in range(n_slots):
        frac = k / float(max(1, n_slots - 1))
        t_k = t_start + frac * raw_duration
        while idx + 1 < total_raw and raw_frames[idx + 1][0] <= t_k:
            idx += 1
        frame_path = out_dir / f"frame_{k + 1:04d}.png"
        frame_path.write_bytes(raw_frames[idx][1])
    return n_slots


def encode_gif_two_pass(
    frame_dir: Path,
    fps: int,
    width: int,
    max_colors: int,
    out_gif: Path,
    bayer_scale: int = 3,
) -> Tuple[int, float, Tuple[int, int]]:
    """FFmpeg 两步调色板法生成高质量公众号 GIF，返回 (总帧数, 体积MB, (宽,高))。"""
    palette_path = frame_dir / "palette.png"
    input_pattern = str(frame_dir / "frame_%04d.png")

    cmd1 = [
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(fps),
        "-i", input_pattern,
        "-vf", f"scale={width}:-1:flags=lanczos,palettegen=max_colors={max_colors}:stats_mode=diff",
        str(palette_path),
    ]
    subprocess.run(cmd1, check=True)

    cmd2 = [
        "ffmpeg", "-y", "-v", "error",
        "-framerate", str(fps),
        "-i", input_pattern,
        "-i", str(palette_path),
        "-lavfi",
        f"scale={width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale={bayer_scale}:diff_mode=rectangle",
        "-loop", "0",
        str(out_gif),
    ]
    subprocess.run(cmd2, check=True)

    size_mb = out_gif.stat().st_size / (1024.0 * 1024.0)
    with Image.open(out_gif) as im:
        n_frames = getattr(im, "n_frames", 1)
        dims = im.size
    return n_frames, size_mb, dims


def build_wechat_gif(
    raw_frames: List[Tuple[float, bytes]],
    t_start: float,
    t_end: float,
    out_gif: Path,
    pref_width: int = 720,
    pref_fps: int = 14,
    max_mb: float = 5.0,
    ideal_max_mb: float = 4.2,
    max_frames: int = 299,
    target_duration_s: Optional[float] = None,
) -> Dict[str, Any]:
    """按画质优先→自动降档阶梯生成严格通过微信门禁（<5MB & <300帧）的 GIF。"""
    ladder = [
        (pref_width, pref_fps, 256, 3),
        (640, min(pref_fps, 14), 256, 3),
        (640, 12, 224, 3),
        (600, 12, 192, 3),
        (560, 11, 160, 4),
        (520, 10, 128, 4),
        (480, 10, 96, 4),
    ]
    # 去重同时保序
    seen = set()
    uniq_ladder = []
    for item in ladder:
        if item not in seen:
            seen.add(item)
            uniq_ladder.append(item)

    last_res: Dict[str, Any] = {}
    with tempfile.TemporaryDirectory(prefix="gif_cap_") as tmp:
        tmp_path = Path(tmp)
        for attempt, (w, fps, colors, bayer) in enumerate(uniq_ladder, 1):
            sub_dir = tmp_path / f"try_{attempt}"
            sub_dir.mkdir(parents=True, exist_ok=True)
            resample_frames_to_cfr(raw_frames, t_start, t_end, fps, sub_dir, target_duration_s=target_duration_s)
            n_frames, size_mb, dims = encode_gif_two_pass(sub_dir, fps, w, colors, out_gif, bayer_scale=bayer)
            dur_s = round(n_frames / float(fps), 2)
            last_res = {
                "width": dims[0],
                "height": dims[1],
                "fps": fps,
                "frames": n_frames,
                "duration_s": dur_s,
                "size_mb": round(size_mb, 2),
                "colors": colors,
                "attempt": attempt,
                "pass_gate": (size_mb < max_mb and n_frames < max_frames),
            }
            if size_mb <= ideal_max_mb and n_frames <= max_frames:
                break
            if size_mb < max_mb and n_frames <= max_frames and attempt >= 2:
                break
    return last_res


# ---------- 单条分镜采集主流程 ----------

def record_one_clip(
    clip: Dict[str, Any],
    base_url: str,
    out_dir: Path,
    defaults: Dict[str, Any],
) -> Dict[str, Any]:
    name = clip["name"]
    rel_url = clip["url"].lstrip("/")
    vp = clip.get("viewport", defaults.get("viewport", {"width": 960, "height": 600}))
    vw, vh = int(vp["width"]), int(vp["height"])
    settle_ms = int(clip.get("settle_ms", defaults.get("settle_ms", 1500)))
    show_cursor = bool(clip.get("show_cursor", defaults.get("show_cursor", True)))
    hide_win_modal = bool(clip.get("hide_win_modal", defaults.get("hide_win_modal", True)))
    block_scans = bool(clip.get("block_textbook_scans", defaults.get("block_textbook_scans", True)))
    pref_width = int(clip.get("gif_width", defaults.get("gif_width", 720)))
    pref_fps = int(clip.get("gif_fps", defaults.get("gif_fps", 14)))
    max_mb = float(clip.get("max_mb", defaults.get("max_mb", 5.0)))
    ideal_max_mb = float(clip.get("ideal_max_mb", defaults.get("ideal_max_mb", 4.0)))

    out_gif = out_dir / f"{name}.gif"
    out_png = out_dir / f"{name}.png"

    print(f"\n[REC] {name} <- {rel_url} ({vw}x{vh}, target {pref_width}px @ {pref_fps}fps)")

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=[
                "--enable-webgl",
                "--ignore-gpu-blocklist",
                "--enable-unsafe-swiftshader",
                "--mute-audio",
                "--disable-background-timer-throttling",
                "--disable-renderer-backgrounding",
            ],
        )
        context = browser.new_context(
            viewport={"width": vw, "height": vh},
            device_scale_factor=1,
        )
        page = context.new_page()

        # 安全护栏：拦截原始教材扫描页与 PDF，杜绝版权红线
        if block_scans:
            def _block_route(route):
                url = route.request.url.lower()
                if "/pages/" in url or url.endswith(".pdf"):
                    route.abort()
                else:
                    route.continue_()
            page.route("**/*", _block_route)

        page.goto(f"{base_url}/{rel_url}", wait_until="networkidle")
        # 等待 WebGL Canvas 挂载并渲染稳定
        page.wait_for_selector("canvas", timeout=15000)
        page.wait_for_timeout(settle_ms)

        if hide_win_modal:
            page.add_style_tag(content="#winToast, .win-toast { display: none !important; opacity: 0 !important; pointer-events: none !important; }")
        if clip.get("extra_css"):
            page.add_style_tag(content=clip["extra_css"])

        raw_frames: List[Tuple[float, bytes]] = []
        runner = ActionRunner(page, show_cursor=show_cursor, raw_frames=raw_frames)
        runner.init_cursor()

        # 录前准备（不入画）
        setup_actions = clip.get("setup", [])
        if setup_actions:
            runner.run_actions(setup_actions, record_mode=False)
            runner._cursor_hide()
            page.wait_for_timeout(int(clip.get("post_setup_ms", 350)))

        # 开启 CDP 无损 PNG 截帧录制
        cdp = context.new_cdp_session(page)
        recording = True

        def on_frame(params: Dict[str, Any]) -> None:
            if not recording:
                return
            ts = time.monotonic()
            data = base64.b64decode(params["data"])
            raw_frames.append((ts, data))
            try:
                cdp.send("Page.screencastFrameAck", {"sessionId": params["sessionId"]})
            except Exception:
                pass

        cdp.on("Page.screencastFrame", on_frame)

        # 首帧兜底：保证 t_start 时刻立即有一帧（即使首段静止）
        t_start = time.monotonic()
        raw_frames.append((t_start, page.screenshot(type="png")))
        cdp.send("Page.startScreencast", {
            "format": "png",
            "maxWidth": vw,
            "maxHeight": vh,
            "everyNthFrame": 2,
        })

        # 执行录中拟人动作
        runner.run_actions(clip.get("actions", []), record_mode=True)

        # 末帧兜底 + 停录
        t_end = time.monotonic()
        raw_frames.append((t_end, page.screenshot(type="png")))
        recording = False
        try:
            cdp.send("Page.stopScreencast")
        except Exception:
            pass

        # 保存高光静帧 PNG
        if runner.highlight_bytes:
            out_png.write_bytes(runner.highlight_bytes)
        else:
            hl_ratio = float(clip.get("highlight_ratio", 0.85))
            hl_idx = min(len(raw_frames) - 1, max(0, int(len(raw_frames) * hl_ratio)))
            out_png.write_bytes(raw_frames[hl_idx][1])

        browser.close()

    print(f"      Captured {len(raw_frames)} raw lossless PNG frames over {t_end - t_start:.2f}s. Encoding GIF...")
    meta = build_wechat_gif(
        raw_frames=raw_frames,
        t_start=t_start,
        t_end=t_end,
        out_gif=out_gif,
        pref_width=pref_width,
        pref_fps=pref_fps,
        max_mb=max_mb,
        ideal_max_mb=ideal_max_mb,
        target_duration_s=clip.get("target_duration_s"),
    )
    meta.update({
        "name": name,
        "title": clip.get("title", name),
        "caption": clip.get("caption", ""),
        "source": rel_url,
        "gif_file": out_gif.name,
        "png_file": out_png.name,
        "gif_path": str(out_gif),
        "png_path": str(out_png),
        "raw_frames": len(raw_frames),
    })
    status = "PASS" if meta["pass_gate"] else "FAIL"
    print(
        f"      [{status}] {out_gif.name} | {meta['width']}x{meta['height']} | "
        f"{meta['duration_s']:.2f}s | {meta['frames']} frames @ {meta['fps']}fps | "
        f"{meta['size_mb']:.2f} MB (attempt #{meta['attempt']})"
    )
    return meta


# ---------- 离线 HTML 预览墙生成 ----------

def build_preview_wall(records: List[Dict[str, Any]], out_dir: Path, title: str = "3D 互动课本 · 公众号动图验收预览墙") -> Path:
    cards_html = []
    total_mb = sum(r["size_mb"] for r in records)
    all_pass = all(r["pass_gate"] for r in records)
    for idx, r in enumerate(records, 1):
        badge_cls = "pass" if r["pass_gate"] else "fail"
        badge_txt = "✅ 通过微信门禁" if r["pass_gate"] else "❌ 超标需重压"
        cards_html.append(f"""
        <article class="card">
          <div class="card-hd">
            <span class="idx">#{idx:02d}</span>
            <div class="titles">
              <h3>{r['title']}</h3>
              <code>{r['gif_file']}</code> · <span class="src">{r['source']}</span>
            </div>
            <span class="badge {badge_cls}">{badge_txt}</span>
          </div>
          <div class="stage">
            <img src="{r['gif_file']}?v={int(time.time())}" alt="{r['title']}" class="gif-view">
          </div>
          <div class="meta">
            <span>📐 <b>{r['width']}×{r['height']}</b></span>
            <span>⏱ <b>{r['duration_s']:.2f}s</b></span>
            <span>🎞 <b>{r['frames']} 帧</b> ({r['fps']}fps)</span>
            <span>📦 <b>{r['size_mb']:.2f} MB</b></span>
          </div>
          <p class="cap">{r.get('caption', '')}</p>
          <div class="foot">
            <a href="{r['gif_file']}" target="_blank">打开原 GIF</a>
            <a href="{r['png_file']}" target="_blank">查看高清静帧 PNG</a>
          </div>
        </article>""")

    html = f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>{title}</title>
<style>
  :root {{ --bg:#f7f2e8; --card:#fffdf8; --ink:#241e16; --muted:#746754; --line:#e3d5bc; --accent:#e56d17; --ok:#16a34a; }}
  * {{ box-sizing:border-box }}
  body {{ margin:0; padding:24px; background:var(--bg); color:var(--ink); font-family:"Noto Sans SC","Microsoft YaHei",sans-serif; }}
  .wrap {{ max-width:1460px; margin:0 auto; }}
  header {{ display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:14px;
    padding:16px 22px; border-radius:20px; background:var(--card); border:1.5px solid var(--line);
    box-shadow:0 8px 24px rgba(68,48,18,.08); margin-bottom:22px; }}
  header h1 {{ margin:0; font-size:22px; }}
  header p {{ margin:4px 0 0; font-size:13.5px; color:var(--muted); }}
  .summary {{ display:flex; gap:10px; flex-wrap:wrap; }}
  .pill {{ padding:6px 14px; border-radius:99px; font-size:13px; font-weight:800; background:#fff6e8; border:1.5px solid #f0cba0; color:#b8550b; }}
  .pill.ok {{ background:#ecfdf3; border-color:#86efac; color:#15803d; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill, minmax(430px, 1fr)); gap:18px; }}
  .card {{ background:var(--card); border:1.5px solid var(--line); border-radius:20px; overflow:hidden;
    box-shadow:0 8px 22px rgba(68,48,18,.08); display:flex; flex-direction:column; }}
  .card-hd {{ display:flex; align-items:center; gap:10px; padding:12px 15px; border-bottom:1px solid #efe4cf; }}
  .idx {{ width:32px; height:32px; border-radius:10px; background:#fff2df; color:var(--accent); font-weight:900;
    display:grid; place-items:center; flex:none; font-size:13px; }}
  .titles {{ flex:1; min-width:0; }}
  .titles h3 {{ margin:0; font-size:16px; }}
  .titles code {{ font-size:11.5px; color:#8a6a42; background:#f8efe0; padding:1px 6px; border-radius:6px; }}
  .titles .src {{ font-size:11.5px; color:var(--muted); }}
  .badge {{ font-size:11.5px; font-weight:900; padding:4px 10px; border-radius:99px; white-space:nowrap; }}
  .badge.pass {{ background:#dcfce7; color:#15803d; }}
  .badge.fail {{ background:#fee2e2; color:#b91c1c; }}
  .stage {{ background:#111827; aspect-ratio:16/10; display:grid; place-items:center; overflow:hidden; }}
  .stage img {{ width:100%; height:100%; object-fit:contain; display:block; }}
  .meta {{ display:flex; flex-wrap:wrap; gap:12px; padding:10px 15px; background:#faf4e8; border-top:1px solid #efe4cf;
    font-size:12.5px; color:#5a4d3a; }}
  .cap {{ margin:0; padding:10px 15px 6px; font-size:13px; color:#504332; line-height:1.5; flex:1; }}
  .foot {{ display:flex; justify-content:space-between; padding:8px 15px 12px; font-size:12.5px; font-weight:800; }}
  .foot a {{ color:var(--accent); text-decoration:none; }}
  .foot a:hover {{ text-decoration:underline; }}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <div>
      <h1>🎬 {title}</h1>
      <p>微信公众平台硬门禁：单张 &lt; 5.0 MB、总帧数 &lt; 300 帧｜全部离线循环预览，点击底部链接可查看 960×600 高清静帧兜底图</p>
    </div>
    <div class="summary">
      <span class="pill {'ok' if all_pass else ''}">{'✅ 全部通过微信门禁' if all_pass else '⚠️ 存在超标项'}</span>
      <span class="pill">共 {len(records)} 条 GIF</span>
      <span class="pill">合计 {total_mb:.2f} MB</span>
    </div>
  </header>
  <section class="grid">
    {''.join(cards_html)}
  </section>
</div>
</body>
</html>
"""
    wall_path = out_dir / "gif_preview_wall.html"
    wall_path.write_text(html, encoding="utf-8")
    return wall_path


# ---------- CLI 入口 ----------

def main() -> None:
    parser = argparse.ArgumentParser(description="3D 互动课本通用 GIF + 高清静帧自动采集工具")
    parser.add_argument("--config", required=True, help="JSON 动作清单配置文件路径")
    parser.add_argument("--out-dir", required=True, help="GIF / PNG / 预览墙输出目录")
    parser.add_argument("--root", default=None, help="本地静态 HTTP 服务器根目录（默认 xiaoxuekexue/）")
    parser.add_argument("--only", nargs="*", default=None, help="仅录制指定的 clip name（可传多个）")
    parser.add_argument("--no-wall", action="store_true", help="跳过生成离线 HTML 预览墙")
    args = parser.parse_args()

    cfg_path = Path(args.config).resolve()
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    root_dir = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    defaults = cfg.get("defaults", {})
    clips = cfg.get("clips", [])
    if args.only:
        only_set = set(args.only)
        clips = [c for c in clips if c["name"] in only_set]
        if not clips:
            print(f"[ERR] 未在配置中找到指定名称: {args.only}", file=sys.stderr)
            sys.exit(1)

    srv, port = start_local_server(root_dir)
    base_url = f"http://127.0.0.1:{port}"
    print(f"[HTTP] Serving {root_dir} at {base_url}")

    report_path = out_dir / "capture_report.json"
    existing: Dict[str, Dict[str, Any]] = {}
    if report_path.exists():
        try:
            for item in json.loads(report_path.read_text(encoding="utf-8")):
                existing[item["name"]] = item
        except Exception:
            pass

    results: List[Dict[str, Any]] = []
    try:
        for clip in clips:
            rec = record_one_clip(clip, base_url, out_dir, defaults)
            existing[rec["name"]] = rec
            results.append(rec)
    finally:
        srv.shutdown()

    # 按 config 原始顺序保存全量报告，便于只重录单条时预览墙依然完整
    ordered_all = [existing[c["name"]] for c in cfg.get("clips", []) if c["name"] in existing]
    report_path.write_text(json.dumps(ordered_all, ensure_ascii=False, indent=2), encoding="utf-8")

    print("\n================ 实测验收表 ================")
    print(f"{'文件名':<28} {'分辨率':<10} {'时长':<7} {'帧数':<6} {'FPS':<5} {'体积MB':<8} {'微信门禁'}")
    print("-" * 82)
    for r in ordered_all:
        gate = "PASS" if r["pass_gate"] else "FAIL"
        print(
            f"{r['gif_file']:<28} {str(r['width'])+'x'+str(r['height']):<10} "
            f"{r['duration_s']:<7.2f} {r['frames']:<6} {r['fps']:<5} {r['size_mb']:<8.2f} {gate}"
        )

    if not args.no_wall and ordered_all:
        wall = build_preview_wall(ordered_all, out_dir, title=cfg.get("wall_title", "3D 互动课本 · 公众号动图验收预览墙"))
        print(f"\n[WALL] 离线预览墙已生成: {wall}")


if __name__ == "__main__":
    main()
