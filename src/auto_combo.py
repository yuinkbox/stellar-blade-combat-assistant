#!/usr/bin/env python3
"""SB Auto Combo - one-key combo helper for Stellar Blade (PC).

Press the toggle key once to start; press it again to stop.
F10 cycles through the combo presets in config.json.

Combo presets are based on the game's actual Incursion / Onslaught strings:
  Incursion II  : S S T T
  Incursion III : S T S T
  Incursion IV  : S S S T T
  Onslaught III : T S hS T
  Onslaught IV  : T S T S T
where S = light attack, T = heavy attack, h = hold.

This is a keyboard/mouse helper. It does not read game memory; auto-potion /
auto-guard / auto-parry are handled by the UE4SS mod instead.
"""

import ctypes
import json
import os
import random
import sys
import threading
import time
from ctypes import wintypes

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

INPUT_MOUSE = 0
INPUT_KEYBOARD = 1

KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008

MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_ulonglong),
    ]


class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_ulonglong),
    ]


class HARDWAREINPUT(ctypes.Structure):
    _fields_ = [
        ("uMsg", wintypes.DWORD),
        ("wParamL", wintypes.WORD),
        ("wParamH", wintypes.WORD),
    ]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("hi", HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


user32.SendInput.argtypes = (wintypes.UINT, ctypes.POINTER(INPUT), ctypes.c_int)
user32.SendInput.restype = wintypes.UINT
user32.MapVirtualKeyW.argtypes = (wintypes.UINT, wintypes.UINT)
user32.MapVirtualKeyW.restype = wintypes.UINT
user32.GetAsyncKeyState.argtypes = (ctypes.c_int,)
user32.GetAsyncKeyState.restype = ctypes.c_short
user32.GetForegroundWindow.restype = wintypes.HWND
user32.GetWindowThreadProcessId.argtypes = (wintypes.HWND, ctypes.POINTER(wintypes.DWORD))
user32.GetWindowThreadProcessId.restype = wintypes.DWORD
kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = (
    wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
)
kernel32.QueryFullProcessImageNameW.restype = wintypes.BOOL
kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel32.CloseHandle.restype = wintypes.BOOL

VK = {
    "backspace": 0x08,
    "tab": 0x09,
    "enter": 0x0D,
    "shift": 0x10,
    "ctrl": 0x11,
    "alt": 0x12,
    "esc": 0x1B,
    "space": 0x20,
    "pageup": 0x21,
    "pagedown": 0x22,
    "end": 0x23,
    "home": 0x24,
    "left": 0x25,
    "up": 0x26,
    "right": 0x27,
    "down": 0x28,
    "insert": 0x2D,
    "delete": 0x2E,
}
for i in range(1, 13):
    VK["f%d" % i] = 0x6F + i
for c in "abcdefghijklmnopqrstuvwxyz":
    VK[c] = ord(c.upper())
for c in "0123456789":
    VK[c] = ord(c)


def step(key, hold_ms=30):
    return {"key": key, "hold_ms": hold_ms}


DEFAULT_COMBOS = {
    # Incursion I: S T T T
    "incursion_i": [step("light"), step("heavy"), step("heavy"), step("heavy")],
    # Incursion II: S S T T - fast, good for mobs (XXYY)
    "incursion_ii": [step("light"), step("light"), step("heavy"), step("heavy")],
    # Incursion III: S T S T - the all-round high-damage string (XYXY)
    "incursion_iii": [step("light"), step("heavy"), step("light"), step("heavy")],
    # Incursion IV: S S S T T - highest light-combo damage
    "incursion_iv": [step("light"), step("light"), step("light"), step("heavy"), step("heavy")],
    # Onslaught I: T T T
    "onslaught_i": [step("heavy"), step("heavy"), step("heavy")],
    # Onslaught II: T S S T
    "onslaught_ii": [step("heavy"), step("light"), step("light"), step("heavy")],
    # Onslaught III: T S hS T - evasive heavy string
    "onslaught_iii": [step("heavy"), step("light"), step("light", 450), step("heavy")],
    # Onslaught IV: T S T S T - highest overall heavy damage
    "onslaught_iv": [step("heavy"), step("light"), step("heavy"), step("light"), step("heavy")],
    # Light string: S S S S - fast pressure and stagger
    "light_chain": [step("light"), step("light"), step("light"), step("light")],
    # Heavy string: T T T T - slow but breaks guard
    "heavy_chain": [step("heavy"), step("heavy"), step("heavy"), step("heavy")],
    # Mixed string: S T T S T - varied rhythm
    "mix_chain": [step("light"), step("heavy"), step("heavy"), step("light"), step("heavy")],
    # Breaker: T T hS T - heavy guard-break route
    "breaker_chain": [step("heavy"), step("heavy"), step("light", 450), step("heavy")],
    # Air launcher/juggle
    "air_chain": [step("jump"), step("light"), step("light"), step("heavy")],
    # Dodge offset into attacks
    "dodge_chain": [step("dodge"), step("light"), step("light"), step("heavy")],
    # Beta Chain variants: hold the final hit to spend BE
    "beta_incursion_iv": [step("light"), step("light"), step("light"), step("heavy"), step("heavy", 450)],
    "beta_onslaught_iv": [step("heavy"), step("light"), step("heavy"), step("light"), step("heavy", 450)],
    "beta_incursion_iii": [step("light"), step("heavy"), step("light"), step("heavy", 450)],
    "beta_onslaught_ii": [step("heavy"), step("light"), step("light"), step("heavy", 450)],
    # Rush Chain II: hT -> T + dodge (chord)
    "rush_chain": [step("heavy", 500), {"key": "heavy", "hold_ms": 30, "with": "dodge"}],
    # Rush: held heavy to close distance
    "rush": [step("heavy", 600)],
    # After a Perfect Parry: Counter II = hT
    "counter_ii": [step("heavy", 450)],
    # After a Perfect Dodge: Reflection I = hS
    "reflection": [step("light", 450)],
}

DEFAULTS = {
    "toggle_key": "F9",
    "once_key": "F8",
    "next_combo_key": "F10",
    "exit_key": "F12",
    "keys": {
        "light": "mouse_left",
        "heavy": "mouse_right",
        "dodge": "shift",
        "guard": "e",
        "heal": "q",
        "skill": "1",
    },
    "active_combo": "incursion_iii",
    "step_interval_ms": 250,
    "combo_end_pause_ms": 1200,
    "flow_link_ms": 55,
    "flow_tail_ms": 80,
    "flow_max_segments": 3,
    "burst_min_enemies": 3,
    "tachy_min_enemies": 4,
    "beta_every_cycles": 2,
    "beta_key": "1",
    "beta_keys": ["1", "2", "3", "4"],
    "beta_roles": {"1": "aoe", "2": "burst", "3": "control", "4": "defense"},
    "burst_keys": ["1", "2", "3", "4"],
    "burst_modifier": "alt",
    "burst_every_cycles": 4,
    "beta_range": 600,
    "burst_range": 800,
    "tachy_range": 400,
    "tachy_keys": ["t"],
    "tachy_cooldown_ms": 20000,
    "auto_relock": True,
    "auto_relock_range": 1600,
    "auto_relock_cooldown_ms": 1200,
    "gap_close_enabled": True,
    "gap_close_max": 2000,
    "gap_close_combo": "rush",
    "gap_close_cooldown_ms": 1200,
    "combo_deck": [
        "incursion_ii", "incursion_iii", "incursion_iv",
        "onslaught_iii", "onslaught_iv",
        "light_chain", "heavy_chain", "mix_chain", "breaker_chain",
    ],
    "finisher_every_cycles": 4,
    "finisher_combo": "rush_chain",
    "execution_combo": "rush_chain",
    "require_focus": True,
    "game_process": "SB-Win64-Shipping.exe",
    "combos": DEFAULT_COMBOS,
}


def config_path():
    if getattr(sys, "frozen", False):
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "config.json")


def save_config(cfg):
    with open(config_path(), "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)


def load_config():
    path = config_path()
    if not os.path.exists(path):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(DEFAULTS, f, indent=2, ensure_ascii=False)
        return json.loads(json.dumps(DEFAULTS))

    with open(path, "r", encoding="utf-8-sig") as f:
        cfg = json.load(f)

    merged = json.loads(json.dumps(DEFAULTS))
    for key, value in cfg.items():
        merged[key] = value
    merged["keys"] = dict(DEFAULTS["keys"])
    merged["keys"].update(cfg.get("keys", {}))
    # Older builds used the incorrect V+T chord.  The save file maps Tachy
    # Mode to keyboard T only (the gamepad uses L3+R3), so migrate that value
    # or Tachy would never activate and V could trigger an unrelated action.
    tachy_keys = [str(k).lower() for k in (merged.get("tachy_keys") or [])]
    tachy_keys = [k for k in tachy_keys if k and k != "v"]
    merged["tachy_keys"] = tachy_keys or ["t"]
    if not cfg.get("combos"):
        merged["combos"] = DEFAULT_COMBOS
    # Add the newer Beta-chain variants and the Rush chain to existing
    # configs.  They are deliberately merged instead of replacing the user's
    # deck: the flow planner can still choose every unlocked string.
    for name in ("beta_incursion_iii", "beta_onslaught_ii", "rush_chain"):
        if name not in merged["combos"] and name in DEFAULT_COMBOS:
            merged["combos"][name] = DEFAULT_COMBOS[name]
    if isinstance(merged.get("combo_deck"), list):
        for name in ("beta_incursion_iii", "beta_onslaught_ii", "rush_chain"):
            if name not in merged["combo_deck"]:
                merged["combo_deck"].append(name)
    if merged.get("active_combo") not in merged["combos"]:
        merged["active_combo"] = next(iter(merged["combos"]))
    return merged


def vk_of(name):
    key = str(name).strip().lower()
    if key.startswith("mouse_"):
        return None
    if key not in VK:
        raise ValueError("unknown key: %s" % name)
    return VK[key]


def is_down(vk):
    return bool(user32.GetAsyncKeyState(vk) & 0x8000)


PROCESS_QUERY_LIMITED_INFORMATION = 0x1000


def foreground_process_name():
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value)
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wintypes.DWORD(len(buf))
        if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
    finally:
        kernel32.CloseHandle(handle)
    return None


def game_focused(cfg):
    if not cfg.get("require_focus", True):
        return True
    name = foreground_process_name()
    expected = str(cfg.get("game_process", "SB-Win64-Shipping.exe")).lower()
    return name is not None and name.lower() == expected


def send_key(name, down):
    key = str(name).strip().lower()
    if key.startswith("mouse_"):
        flags = {
            "mouse_left": MOUSEEVENTF_LEFTDOWN if down else MOUSEEVENTF_LEFTUP,
            "mouse_right": MOUSEEVENTF_RIGHTDOWN if down else MOUSEEVENTF_RIGHTUP,
            "mouse_middle": MOUSEEVENTF_MIDDLEDOWN if down else MOUSEEVENTF_MIDDLEUP,
        }.get(key)
        if flags is None:
            raise ValueError("unknown mouse button: %s" % name)
        inp = INPUT(type=INPUT_MOUSE)
        inp.mi = MOUSEINPUT(0, 0, 0, flags, 0, 0)
    else:
        vk = vk_of(key)
        scan = user32.MapVirtualKeyW(vk, 0)
        flags = KEYEVENTF_SCANCODE | (KEYEVENTF_KEYUP if not down else 0)
        inp = INPUT(type=INPUT_KEYBOARD)
        inp.ki = KEYBDINPUT(0, scan, flags, 0, 0)
    sent = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    if sent == 0:
        print("[SB Auto Combo] SendInput failed: %d" % ctypes.get_last_error(), file=sys.stderr)
    return sent


def tap(name, hold_ms=30):
    send_key(name, True)
    time.sleep(hold_ms / 1000.0)
    send_key(name, False)


def combo_step_delay(item, fallback_ms=140):
    explicit = item.get("delay_ms")
    if explicit is not None:
        return float(explicit) / 1000.0
    key = item.get("key")
    hold = int(item.get("hold_ms", 30))
    # The old cadence used a flat 120/150 ms, which made every string feel
    # metronomic and left visible gaps between attacks.  Scale from the
    # configured interval instead: lights are the fastest link, heavies get a
    # little more room, and charged finishers get one extra beat.  The game
    # buffers combo inputs, so a slightly early press is preferable to a
    # visibly idle character.
    base_ms = float(fallback_ms or 140)
    if key == "light":
        delay_ms = base_ms * 0.80
    elif key == "heavy":
        delay_ms = base_ms * 0.96
    else:
        delay_ms = base_ms * 0.94
    if hold > 300:
        delay_ms += base_ms * 0.18
    # Small asymmetric jitter: never two identical-looking presses in a row.
    delay_ms += random.uniform(-3.0, 7.0)
    return max(0.075, delay_ms / 1000.0)


def run_combo(cfg, name, state=None):
    steps = cfg["combos"].get(name)
    if not steps:
        return
    for item in steps:
        if state is not None and (state["stop"] or not state["running"]):
            return
        with_key = item.get("with")
        hold_ms = int(item.get("hold_ms", 30))
        if item.get("key") == "heavy" and hold_ms < 55:
            hold_ms = 55
        if with_key:
            send_key(cfg["keys"][with_key], True)
        tap(cfg["keys"][item["key"]], hold_ms)
        if with_key:
            send_key(cfg["keys"][with_key], False)
        time.sleep(combo_step_delay(item, cfg.get("step_interval_ms", 140)))
    time.sleep(cfg["combo_end_pause_ms"] / 1000.0)


def print_combos(cfg):
    print("[SB Auto Combo] combos:")
    for name, steps in cfg["combos"].items():
        text = " ".join(
            ("%s(h%d)" % (s["key"], int(s.get("hold_ms", 30)))) for s in steps
        )
        print("  %-16s %s" % (name, text))


def main():
    cfg = load_config()
    once = "--once" in sys.argv
    list_only = "--list" in sys.argv

    print("[SB Auto Combo] config:", config_path())
    print("[SB Auto Combo] toggle:", cfg["toggle_key"],
          " once:", cfg["once_key"],
          " next:", cfg["next_combo_key"], " exit:", cfg["exit_key"])
    print_combos(cfg)

    if list_only:
        return

    if once:
        if not game_focused(cfg):
            print("[SB Auto Combo] game window is not focused; click the game first")
            return
        run_combo(cfg, cfg["active_combo"])
        print("[SB Auto Combo] sent one", cfg["active_combo"])
        return

    toggle_vk = vk_of(cfg["toggle_key"])
    once_vk = vk_of(cfg["once_key"])
    next_vk = vk_of(cfg["next_combo_key"])
    exit_vk = vk_of(cfg["exit_key"])
    combo_names = list(cfg["combos"].keys())
    state = {
        "running": False,
        "stop": False,
        "once_requested": False,
        "combo_index": combo_names.index(cfg["active_combo"]),
        "cycle": 0,
        "focus_warned": False,
    }

    def hotkey_loop():
        last_toggle = False
        last_once = False
        last_next = False
        while not state["stop"]:
            if is_down(exit_vk):
                state["stop"] = True
                print("[SB Auto Combo] exit")
                return

            now_toggle = is_down(toggle_vk)
            if now_toggle and not last_toggle:
                state["running"] = not state["running"]
                print("[SB Auto Combo] %s" % ("RUNNING" if state["running"] else "STOPPED"))
            last_toggle = now_toggle

            now_once = is_down(once_vk)
            if now_once and not last_once and not state["running"]:
                state["once_requested"] = True
            last_once = now_once

            now_next = is_down(next_vk)
            if now_next and not last_next:
                state["combo_index"] = (state["combo_index"] + 1) % len(combo_names)
                print("[SB Auto Combo] combo ->", combo_names[state["combo_index"]])
            last_next = now_next

            time.sleep(0.02)

    threading.Thread(target=hotkey_loop, daemon=True).start()
    print("[SB Auto Combo] waiting; %s start/stop, %s one combo, %s next combo"
          % (cfg["toggle_key"], cfg["once_key"], cfg["next_combo_key"]))

    while not state["stop"]:
        if not game_focused(cfg):
            if not state["focus_warned"]:
                print("[SB Auto Combo] game window is not focused; click the game")
                state["focus_warned"] = True
            time.sleep(0.2)
            continue
        state["focus_warned"] = False

        name = combo_names[state["combo_index"]]

        if state["once_requested"] and not state["running"]:
            state["once_requested"] = False
            print("[SB Auto Combo] one", name)
            run_combo(cfg, name)
            continue

        if not state["running"]:
            time.sleep(0.02)
            continue

        run_combo(cfg, name, state)
        state["cycle"] += 1

        beta_every = int(cfg.get("beta_every_cycles") or 0)
        if beta_every > 0 and state["cycle"] % beta_every == 0:
            tap(cfg.get("beta_key") or cfg["keys"]["skill"])
            time.sleep(0.3)


if __name__ == "__main__":
    main()
