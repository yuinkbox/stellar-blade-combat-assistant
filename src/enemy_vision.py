"""Optional screen-space enemy health-bar reader.

This is deliberately a *display-only* experiment.  It captures the game
window with PrintWindow (no overlay pollution), looks for a stable horizontal
red/orange bar in the upper-middle of the frame, and learns the full-bar width
from the widest clean bar it has seen while locked.  It never presses keys and
never changes combat decisions unless the caller explicitly chooses to use it.

The game runs fullscreen, so PrintWindow is the only reliable capture path that
does not include our own always-on-top windows.
"""

import ctypes
import threading
import time
from ctypes import wintypes

import numpy as np
from PIL import Image


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PW_RENDERFULLCONTENT = 2


class _BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]


def _process_image_name(pid):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not handle:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return buf.value
    finally:
        kernel32.CloseHandle(handle)
    return ""


def find_game_window(process_name="SB-Win64-Shipping.exe"):
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if not pid.value:
            return True
        name = _process_image_name(pid.value)
        if name and name.lower().endswith(process_name.lower()):
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(callback, 0)
    return found[0] if found else 0


def _capture_window(hwnd):
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)
    rect = wintypes.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        return None
    width = rect.right - rect.left
    height = rect.bottom - rect.top
    if width < 320 or height < 240:
        return None
    hdc = user32.GetWindowDC(hwnd)
    mem = gdi32.CreateCompatibleDC(hdc)
    bmp = gdi32.CreateCompatibleBitmap(hdc, width, height)
    old = gdi32.SelectObject(mem, bmp)
    ok = user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT)
    result = None
    if ok:
        header = _BITMAPINFOHEADER()
        header.biSize = ctypes.sizeof(_BITMAPINFOHEADER)
        header.biWidth = width
        header.biHeight = -height
        header.biPlanes = 1
        header.biBitCount = 32
        header.biCompression = 0
        buf = ctypes.create_string_buffer(width * height * 4)
        if gdi32.GetDIBits(mem, bmp, 0, height, buf, ctypes.byref(header), 0):
            image = Image.frombuffer("RGB", (width, height), buf, "raw", "BGRX", 0, 1)
            result = image.resize((640, max(1, int(640 * height / width))), Image.BILINEAR)
    gdi32.SelectObject(mem, old)
    gdi32.DeleteObject(bmp)
    gdi32.DeleteDC(mem)
    user32.ReleaseDC(hwnd, hdc)
    return result


def _longest_red_run(row):
    """Return (start, end, length) for the longest contiguous red run."""
    try:
        indices = np.flatnonzero(row)
    except Exception:
        return None
    if not len(indices):
        return None
    breaks = np.flatnonzero(np.diff(indices) > 1)
    starts = np.concatenate(([0], breaks + 1))
    ends = np.concatenate((breaks, [len(indices) - 1]))
    best = None
    for a, b in zip(starts, ends):
        length = int(indices[b] - indices[a] + 1)
        if best is None or length > best[2]:
            best = (int(indices[a]), int(indices[b]), length)
    return best


def detect_health_bar(image):
    """Return (ratio, confidence, width, reference) or (None, 0, 0, 0)."""
    if image is None or image.width < 160:
        return None, 0.0, 0, 0
    arr = np.asarray(image.convert("RGB")).astype(np.int16)
    height, width = arr.shape[:2]
    y0, y1 = int(height * 0.06), int(height * 0.52)
    x0, x1 = int(width * 0.14), int(width * 0.86)
    band = arr[y0:y1, x0:x1]
    if band.size == 0:
        return None, 0.0, 0, 0
    r, g, b = band[:, :, 0], band[:, :, 1], band[:, :, 2]
    mask = (r > 105) & (r > g * 1.22 + 8) & (r > b * 1.22 + 8)
    minimum = max(18, int(width * 0.035))
    maximum = int(width * 0.72)
    rows = []
    for y in range(mask.shape[0]):
        run = _longest_red_run(mask[y])
        if run and minimum <= run[2] <= maximum:
            rows.append((y0 + y, x0 + run[0], x0 + run[1], run[2]))
    if len(rows) < 4:
        return None, 0.0, 0, 0

    # A real bar is several adjacent rows of almost identical width and x.
    best = None
    for i in range(len(rows)):
        group = [rows[i]]
        for j in range(i + 1, min(i + 12, len(rows))):
            py, px0, px1, plen = group[-1]
            y, x_start, x_end, length = rows[j]
            if y - py > 1:
                break
            if abs(length - plen) <= max(5, plen * 0.18) and abs(x_start - px0) <= max(6, width * 0.02):
                group.append(rows[j])
        if len(group) >= 5:
            lengths = [r[2] for r in group]
            length = int(np.median(lengths))
            score = length * len(group)
            if best is None or score > best[0]:
                best = (score, length, len(group))
    if best is None:
        return None, 0.0, 0, 0

    _, length, depth = best
    confidence = min(1.0, (depth / 8.0) * 0.75 + min(0.25, length / max(1, width) * 0.8))
    return length, confidence, length, 0


class EnemyHealthVision:
    """Background capture loop.  Access fields through snapshot()."""

    def __init__(self, can_read=None, interval=0.25):
        self.can_read = can_read
        self.interval = interval
        self._stop = threading.Event()
        self._thread = None
        self._hwnd = 0
        self._reference = 0
        self._ratio = None
        self._confidence = 0.0
        self._width = 0
        self._error = ""

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run, name="enemy-health-vision", daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()
        self._thread = None
        self._hwnd = 0
        self._ratio = None
        self._confidence = 0.0

    def snapshot(self):
        return {
            "ratio": self._ratio,
            "confidence": self._confidence,
            "width": self._width,
            "error": self._error,
        }

    def _run(self):
        while not self._stop.is_set():
            try:
                if self.can_read is not None and not self.can_read():
                    self._stop.wait(0.15)
                    continue
                if not self._hwnd or not ctypes.windll.user32.IsWindow(self._hwnd):
                    self._hwnd = find_game_window()
                if not self._hwnd:
                    self._error = "未找到游戏窗口"
                    self._stop.wait(0.5)
                    continue
                image = _capture_window(self._hwnd)
                width, confidence, raw_width, _ = detect_health_bar(image)
                if width:
                    if self._reference <= 0 or width > self._reference * 1.06:
                        self._reference = width
                    ratio = max(0.0, min(1.0, float(width) / float(self._reference)))
                    self._ratio = ratio
                    self._confidence = confidence
                    self._width = raw_width
                    self._error = ""
            except Exception as exc:  # noqa: BLE001 - background reader must not die
                self._error = str(exc)
            self._stop.wait(self.interval)
