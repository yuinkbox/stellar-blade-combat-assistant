import ctypes
import json
import math
import os
import tkinter as tk
from tkinter import ttk

from PIL import Image, ImageTk

# Fallback anchor until a 3-point calibration is saved.
ANCHOR_WORLD = (4755.6, -2328.9)
ANCHOR_PIXEL = (607.5, 403.9)
SCALE_X = 0.0184
SCALE_Y = 0.0071
VIEW_W = 560
VIEW_H = 420


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def _write_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)


def solve_affine(anchors):
    if len(anchors) < 3:
        return None
    p = anchors[:3]
    x1, y1 = p[0]["world"][:2]
    x2, y2 = p[1]["world"][:2]
    x3, y3 = p[2]["world"][:2]
    u1, v1 = p[0]["pixel"][:2]
    u2, v2 = p[1]["pixel"][:2]
    u3, v3 = p[2]["pixel"][:2]
    den = (x1 - x2) * (y1 - y3) - (x1 - x3) * (y1 - y2)
    if abs(den) < 1e-9:
        return None
    a = ((u1 - u2) * (y1 - y3) - (u1 - u3) * (y1 - y2)) / den
    b = ((x1 - x2) * (u1 - u3) - (x1 - x3) * (u1 - u2)) / den
    c = u1 - a * x1 - b * y1
    d = ((v1 - v2) * (y1 - y3) - (v1 - v3) * (y1 - y2)) / den
    e = ((x1 - x2) * (v1 - v3) - (x1 - x3) * (v1 - v2)) / den
    f = v1 - d * x1 - e * y1
    return [a, b, c, d, e, f]


def apply_affine(affine, world):
    a, b, c, d, e, f = affine
    x, y = float(world[0]), float(world[1])
    return a * x + b * y + c, d * x + e * y + f


class GameMapHud:
    def __init__(self, root, map_path, state_path, calibration_path):
        self.root = root
        self.map_path = map_path
        self.state_path = state_path
        self.calibration_path = calibration_path
        self.image = Image.open(map_path).convert("RGB")
        self.affine = None
        self.win = tk.Toplevel(root)
        self.win.overrideredirect(True)
        self.win.attributes("-topmost", True)
        self.win.attributes("-alpha", 0.94)
        try:
            self.win.wm_attributes("-transparentcolor", "#000000")
        except Exception:
            pass
        sw = self.win.winfo_screenwidth()
        self.win.geometry("%dx%d+%d+%d" % (VIEW_W, VIEW_H, max(0, sw - VIEW_W - 24), 42))
        self.canvas = tk.Canvas(self.win, width=VIEW_W, height=VIEW_H,
                                bg="#000000", highlightthickness=0)
        self.canvas.pack(fill="both", expand=True)
        self._clickthrough()
        self.photo = None
        self.reload_calibration()

    def _clickthrough(self):
        try:
            hwnd = ctypes.windll.user32.GetParent(self.win.winfo_id())
            gwl = -20
            style = ctypes.windll.user32.GetWindowLongW(hwnd, gwl)
            ctypes.windll.user32.SetWindowLongW(hwnd, gwl, style | 0x00080000 | 0x00000020)
        except Exception:
            pass

    def reload_calibration(self):
        data = _read_json(self.calibration_path, {}) or {}
        affine = data.get("affine")
        if isinstance(affine, list) and len(affine) == 6:
            self.affine = affine
        else:
            self.affine = None

    def _state(self):
        return _read_json(self.state_path, {}) or {}

    def update(self):
        state = self._state()
        if not state or not state.get("player"):
            return
        if self.affine:
            px, py = apply_affine(self.affine, state["player"])
        else:
            px = ANCHOR_PIXEL[0] + (float(state["player"][0]) - ANCHOR_WORLD[0]) * SCALE_X
            py = ANCHOR_PIXEL[1] + (float(state["player"][1]) - ANCHOR_WORLD[1]) * SCALE_Y
        half_w, half_h = VIEW_W / 2, VIEW_H / 2
        left = max(0, min(self.image.width - VIEW_W, int(px - half_w)))
        top = max(0, min(self.image.height - VIEW_H, int(py - half_h)))
        crop = self.image.crop((left, top, left + VIEW_W, top + VIEW_H))
        self.photo = ImageTk.PhotoImage(crop)
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self.photo, anchor="nw")
        cx, cy = px - left, py - top
        yaw = float(state.get("yaw") or 0)
        rad = math.radians(yaw)
        fx, fy = math.sin(rad), math.cos(rad)
        rx, ry = fy, -fx
        pts = [
            cx + fx * 12, cy - fy * 12,
            cx - fx * 6 - rx * 6, cy + fy * 6 + ry * 6,
            cx - fx * 6 + rx * 6, cy + fy * 6 - ry * 6,
        ]
        self.canvas.create_polygon(pts, fill="#22d3ee", outline="#ffffff", width=1)
        label = "XION" if self.affine else "XION · 未标定"
        self.canvas.create_text(12, 12, text=label, fill="#67e8f9", anchor="nw",
                                font=("Microsoft YaHei", 11, "bold"))

    def destroy(self):
        try:
            self.win.destroy()
        except Exception:
            pass


class CalibrationWindow:
    def __init__(self, root, map_path, state_path, calibration_path, on_saved=None, log=None):
        self.root = root
        self.map_path = map_path
        self.state_path = state_path
        self.calibration_path = calibration_path
        self.on_saved = on_saved
        self.log = log or (lambda msg: None)
        self.image = Image.open(map_path).convert("RGB")
        self.max_w, self.max_h = 1100, 720
        self.scale = min(self.max_w / self.image.width, self.max_h / self.image.height)
        self.disp_w = int(self.image.width * self.scale)
        self.disp_h = int(self.image.height * self.scale)
        self.anchors = []
        self.win = tk.Toplevel(root)
        self.win.title("HUD 标定 - 站在地标上点击地图对应位置")
        self.win.attributes("-topmost", True)
        self.win.geometry("%dx%d" % (self.disp_w + 20, self.disp_h + 110))
        self.canvas = tk.Canvas(self.win, width=self.disp_w, height=self.disp_h,
                                highlightthickness=0, cursor="crosshair")
        self.canvas.pack(padx=10, pady=(8, 4))
        self.photo = ImageTk.PhotoImage(self.image.resize((self.disp_w, self.disp_h), Image.LANCZOS))
        self.canvas.create_image(0, 0, image=self.photo, anchor="nw")
        self.status = tk.StringVar(value="请站在游戏内第 1 个地标上，然后点击地图对应位置。")
        ttk.Label(self.win, textvariable=self.status).pack(anchor="w", padx=10)
        bar = ttk.Frame(self.win)
        bar.pack(fill="x", padx=10, pady=6)
        ttk.Button(bar, text="清空重来", command=self.reset).pack(side="left")
        ttk.Button(bar, text="关闭", command=self.win.destroy).pack(side="right")
        self.canvas.bind("<Button-1>", self.on_click)

    def _state(self):
        return _read_json(self.state_path, {}) or {}

    def on_click(self, event):
        if len(self.anchors) >= 3:
            return
        state = self._state()
        if not state or not state.get("player"):
            self.status.set("读取不到玩家位置：请先进入游戏，不要停在菜单/加载。")
            return
        px = event.x / self.scale
        py = event.y / self.scale
        wx, wy = float(state["player"][0]), float(state["player"][1])
        self.anchors.append({"world": [wx, wy], "pixel": [px, py]})
        idx = len(self.anchors)
        self.canvas.create_oval(event.x - 7, event.y - 7, event.x + 7, event.y + 7,
                                outline="#f87171", width=2)
        self.canvas.create_text(event.x + 12, event.y - 12, text=str(idx),
                                fill="#f87171", font=("Microsoft YaHei", 12, "bold"))
        if idx < 3:
            self.status.set("已记录 %d/3。请走到下一个地标，再点击地图对应位置。" % idx)
            return
        affine = solve_affine(self.anchors)
        if affine is None:
            self.anchors.pop()
            self.status.set("这 3 个点共线/重复，无法计算。请清空后换 3 个分散地点。")
            return
        # Xion's map is roughly 0.01-0.03 px per world unit. A wildly different
        # scale means the three clicks came from different maps/regions.
        a, b, c, d, e, f = affine
        sx = math.hypot(a, b)
        sy = math.hypot(d, e)
        if not (0.004 <= sx <= 0.08 and 0.004 <= sy <= 0.08):
            self.anchors.pop()
            self.status.set("这 3 个点不像同一张 Xion 地图（跨度太大）。请全部在 Xion 地图内重标。")
            return
        _write_json(self.calibration_path, {"anchors": self.anchors, "affine": affine})
        self.status.set("标定完成，HUD 已更新。可以关闭窗口。")
        self.log("HUD 3 点标定完成")
        if self.on_saved:
            self.on_saved()

    def reset(self):
        self.anchors = []
        self.canvas.delete("all")
        self.canvas.create_image(0, 0, image=self.photo, anchor="nw")
        self.status.set("已清空。请站在第 1 个地标上，点击地图对应位置。")
