#!/usr/bin/env python3
"""SB Combat Assistant - one desktop app for Stellar Blade.

Combines:
  * Frida/CModule native defense engine (auto guard/parry, dodge, blink/repulse)
  * one-key auto combo using the game's real Incursion / Onslaught strings
  * auto potion from the engine's actual HP trace
  * emergency stop, single instance, foreground-only input

The native defense runtime is loaded from ./runtime next to the EXE.
"""

import ctypes
import json
import math
import os
import queue
import random
import subprocess
import sys
import threading
import time
import tkinter as tk
from ctypes import wintypes
from tkinter import messagebox, ttk

import auto_combo as ac
import ammo_patch
import drop_patch
import enemy_vision
import game_hud
import guide_map

try:
    import frida
except Exception:
    frida = None

APP_TITLE = 'SB Combat Assistant'
MUTEX_NAME = 'Local\\SBCombatAssistant.SingleInstance'
RUNTIME_FILES = ("stellar_runtime_locator.js", "auto_combined_defense_v11.js")
DEFAULT_STATE_PATH = (
    'E:\\Steam\\steamapps\\common\\StellarBlade\\SB\\Binaries\\Win64\\ue4ss\\Mods\\SBAutoBattleState\\state.json'
    r"\ue4ss\Mods\SBAutoBattleState\state.json"
)

# A flow is not a random pick from a flat deck.  It is a short arc:
# fast opener -> pressure link -> committed finisher.  The actual string for
# each slot is still chosen from every unlocked combo, so the same situation
# rarely produces the same three attacks twice.
FLOW_OPENERS = (
    "incursion_ii", "incursion_iii", "light_chain", "onslaught_ii",
    "mix_chain", "dodge_chain", "incursion_i", "onslaught_i",
)
FLOW_LINKS = (
    "incursion_iii", "incursion_iv", "mix_chain", "onslaught_ii",
    "onslaught_iv", "dodge_chain", "breaker_chain",
)
FLOW_FINISHERS = (
    "incursion_iv", "onslaught_iii", "onslaught_iv", "breaker_chain",
    "heavy_chain", "beta_incursion_iii", "beta_incursion_iv",
    "beta_onslaught_ii", "beta_onslaught_iv", "rush_chain",
)
FLOW_DANGER = ("dodge_chain", "incursion_ii", "mix_chain", "onslaught_ii")


def base_dir():
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


RUNTIME_DIR = os.path.join(base_dir(), 'runtime')


class DefenseEngine:
    'Owns one Frida session and loads the native defense agent.'

    def __init__(self, log):
        self.log = log
        self.lock = threading.RLock()
        self.session = None
        self.script = None
        self.enabled = True
        self.reload_requested = False
        self.stop_event = threading.Event()
        self.flags = {"guard": True, "dodge": True, "special": True}
        self.snap = {
            "connected": False,
            "binding": None,
            "binding_message": "",
            "hp_valid": False,
            "hp": 0,
            "max_hp": 0,
            "guard_requests": 0,
            "guard_installed": 0,
            "guard_refused": 0,
            "attempts": 0,
            "installed": 0,
            "rejected": 0,
            "blue": 0,
            "purple": 0,
            "error": None,
        }
        self.last_error = None
        self.last_error_at = 0.0
        threading.Thread(target=self._worker, daemon=True).start()

    # ------------------------------------------------------------- public
    def set_enabled(self, enabled):
        with self.lock:
            self.enabled = bool(enabled)
            if not self.enabled:
                self.reload_requested = False

    def set_flags(self, guard, dodge, special):
        with self.lock:
            self.flags = {"guard": bool(guard), "dodge": bool(dodge), "special": bool(special)}
            self.enabled = True
            self.reload_requested = True

    def snapshot(self):
        with self.lock:
            return dict(self.snap)

    def shutdown(self):
        self.stop_event.set()
        self._unload()

    # ------------------------------------------------------------- worker
    def _worker(self):
        while not self.stop_event.is_set():
            with self.lock:
                enabled = self.enabled
                reload_now = self.reload_requested
                self.reload_requested = False
                flags = dict(self.flags)

            if not enabled:
                if self.script is not None:
                    self._unload()
                with self.lock:
                    self.snap['connected'] = False
                    self.snap['binding'] = None
                time.sleep(0.5)
                continue

            if self.script is not None and reload_now:
                self._unload()

            if self.script is None:
                try:
                    self._load(flags)
                except Exception as exc:
                    self._note_error('加载防御引擎失败: %s' % exc)
                    time.sleep(2.0)
                    continue

            try:
                status = self.script.exports_sync.status(
                    {"includeDiagnostics": False, "includeDetails": False}
                )
                self._update(status)
            except Exception as exc:
                self._note_error('防御引擎状态读取失败: %s' % exc)
                self._unload()
                time.sleep(1.0)
                continue

            time.sleep(0.45)

    def _load(self, flags):
        if frida is None:
            raise RuntimeError('未找到 frida 模块')
        for name in RUNTIME_FILES:
            path = os.path.join(RUNTIME_DIR, name)
            if not os.path.isfile(path):
                raise RuntimeError('缺少运行时文件: %s' % path)

        with open(os.path.join(RUNTIME_DIR, 'stellar_runtime_locator.js'), 'r', encoding='utf-8') as f:
            locator = f.read()
        with open(os.path.join(RUNTIME_DIR, 'auto_combined_defense_v11.js'), 'r', encoding='utf-8') as f:
            defense = f.read()

        guard = flags['guard']
        dodge = flags['dodge']
        special = flags['special']
        observe = not (guard or dodge or special)
        prefix = (
            "globalThis.STELLAR_OBSERVE_ONLY=%s;\n"
            "globalThis.STELLAR_GUARD_DISABLED=%s;\n"
            "globalThis.STELLAR_DODGE_DISABLED=%s;\n"
            "globalThis.STELLAR_SPECIAL_DISABLED=%s;\n"
            "globalThis.STELLAR_DIAGNOSTICS=false;\n"
            "globalThis.STELLAR_STARTUP_TRACE=false;\n"
            % (
                str(observe).lower(),
                str(not guard).lower(),
                str(not dodge).lower(),
                str(not special).lower(),
            )
        )
        source = prefix + '\n' + locator + '\n' + defense

        session = frida.attach('SB-Win64-Shipping.exe')
        script = session.create_script(source, runtime='v8')
        script.on('message', self._on_message)
        script.load()

        with self.lock:
            self.session = session
            self.script = script
            self.snap['connected'] = True
            self.snap['error'] = None
        self.log('防御引擎已加载：guard=')

    def _on_message(self, message, data):
        if message.get('type') == 'error':
            self.log('防御引擎脚本错误: %s')

    def _update(self, status):
        binding = status.get('bindingStatus') or {}
        health = status.get('healthTrace') or {}
        guard = status.get('guardRoute') or {}
        special = status.get('specialResponses') or {}
        stats = status.get('stats') or {}
        with self.lock:
            self.snap.update({
                "connected": True,
                "binding": binding.get("code"),
                "binding_message": binding.get("message") or "",
                "hp_valid": bool(health.get("valid")),
                "hp": int(health.get("currentHp") or 0),
                "max_hp": int(health.get("maxHp") or 0),
                "guard_requests": int(guard.get("requests") or 0),
                "guard_installed": int(guard.get("installed") or 0),
                "guard_refused": int(guard.get("refused") or 0),
                "attempts": int(stats.get("attempts") or 0),
                "installed": int(stats.get("installed") or 0),
                "rejected": int(stats.get("rejected") or 0),
                "blue": int(special.get("blue") or 0),
                "purple": int(special.get("purple") or 0),
                "error": None,
            })

    def _unload(self):
        with self.lock:
            script = self.script
            session = self.session
            self.script = None
            self.session = None
            self.snap['connected'] = False
            self.snap['binding'] = None
        if script is not None:
            try:
                script.exports_sync.stop()
            except Exception:
                pass
            try:
                script.unload()
            except Exception:
                pass
        if session is not None:
            try:
                session.detach()
            except Exception:
                pass

    def _note_error(self, text):
        now = time.time()
        with self.lock:
            self.snap['error'] = text
            self.snap['connected'] = False
        if self.last_error != text or now - self.last_error_at > 8:
            self.last_error = text
            self.last_error_at = now
            self.log(text)


class App:
    def __init__(self, root):
        self.root = root
        self.root.title(APP_TITLE)
        self.root.geometry('720x640')
        self.root.minsize(660, 580)

        self.cfg = ac.load_config()
        self.combo_names = list(self.cfg['combos'].keys())
        self.combo_state = {
            "running": True,
            "stop": False,
            "once": False,
            "combo_index": self.combo_names.index(self.cfg["active_combo"]),
            "cycle": 0,
        }
        self.log_queue = queue.Queue()
        self.started_at = time.time()
        self.stop_all = False
        self.combo_on = False
        self.emergency = False
        self.lock_entered_at = 0.0
        self.auto_engage = bool(self.cfg.get('auto_engage', True))
        self.attack_range = int(self.cfg.get('attack_range', 300))
        self.engage_distance = int(self.cfg.get('engage_distance', 1200))
        rotation = self.cfg.get('auto_rotation') or []
        self.rotation = [name for name in rotation if name in self.cfg['combos']]
        if not self.rotation:
            self.rotation = [name for name in self.combo_names if name != 'counter_ii' and name != 'reflection']
        deck = self.cfg.get('combo_deck') or self.rotation
        self.combo_deck = [name for name in deck if name in self.cfg['combos']]
        if not self.combo_deck:
            self.combo_deck = list(self.rotation)
        self.recent_combos = []
        self.rotation_index = 0
        self.beta_keys = self.cfg.get('beta_keys') or [self.cfg.get('beta_key') or '1']
        self.beta_roles = self.cfg.get('beta_roles') or {}
        self.beta_index = 0
        self.last_beta = 0.0
        self.burst_keys = self.cfg.get("burst_keys") or ["1", "2", "3", "4"]
        self.burst_modifier = self.cfg.get('burst_modifier') or 'alt'
        self.burst_every = int(self.cfg.get('burst_every_cycles') or 0)
        self.burst_index = 0
        self.last_burst = 0.0
        self.tachy_keys = self.cfg.get('tachy_keys') or ['t']
        self.tachy_cooldown = int(self.cfg.get('tachy_cooldown_ms') or 20000) / 1000.0
        self.beta_range = float(self.cfg.get('beta_range') or 600)
        self.burst_range = float(self.cfg.get('burst_range') or 800)
        self.tachy_range = float(self.cfg.get('tachy_range') or 400)
        self.last_tachy = 0.0
        self.auto_relock = bool(self.cfg.get('auto_relock', True))
        self.auto_relock_range = float(self.cfg.get('auto_relock_range') or 1600)
        self.auto_relock_cooldown = max(
            0.3, float(self.cfg.get('auto_relock_cooldown_ms') or 1200) / 1000.0
        )
        self.was_locked = False
        self.last_relock = 0.0
        self.gap_close_enabled = bool(self.cfg.get('gap_close_enabled', True))
        self.gap_close_max = float(self.cfg.get('gap_close_max') or 2000)
        self.gap_close_combo = self.cfg.get('gap_close_combo') or 'rush'
        self.gap_close_cooldown = int(self.cfg.get('gap_close_cooldown_ms') or 1200) / 1000.0
        self.last_gap_close = 0.0
        self.gap_interrupt_distance = max(self.attack_range * 2.0, 700.0)
        self.decision_role = 'single'
        self.last_decision_role = None
        self.finisher_every = int(self.cfg.get('finisher_every_cycles') or 0)
        self.finisher_combo = self.cfg.get('finisher_combo') or 'rush_chain'
        self.execution_combo = self.cfg.get('execution_combo') or 'rush_chain'
        self.last_execution = 0.0
        self.current_auto_combo = self.combo_deck[0] if self.combo_deck else self.current_combo()
        self.flow_link_ms = int(self.cfg.get('flow_link_ms') or 55)
        self.flow_tail_ms = int(self.cfg.get('flow_tail_ms') or 80)
        self.flow_max_segments = max(1, int(self.cfg.get('flow_max_segments') or 3))
        self.flow_step = 0
        self.last_flow_plan = []
        self.auto_state = {}
        self.auto_state_at = 0.0
        self.forward_down = False
        self.last_lock = 0.0
        self.last_player = None
        self.last_move_at = time.time()
        self.stuck_attempts = 0
        self.last_counter = 0.0
        self.last_enemy_count = 0
        self.tactic_var = tk.StringVar(value='战术：等待锁定')
        self.auto_potion = True
        self.threshold = 35
        self.last_potion = 0.0
        self.last_hp = None
        self.urgent_until = 0.0
        self.map_window = None
        self.map_canvas = None
        self.map_toggle_requested = False
        self.guide_map_requested = False
        self.capture_requested = False
        self.game_hud = None
        self.game_hud_requested = False
        self.map_server = None
        self.guide_process = None
        self.engine = DefenseEngine(self.log)
        self.vision_reader = enemy_vision.EnemyHealthVision(can_read=self.vision_can_read)
        self.vision_var = None

        self._build_ui()
        self.root.after(80, self.apply_dark_titlebar)
        self._start_threads()
        self.root.protocol('WM_DELETE_WINDOW', self.on_close)
        self.root.after(120, self.refresh)
        self.log('软件已启动。默认不自动攻击；按 F9 或点“开始自动战斗”。')
        self.log('防御引擎会自动连接游戏，F7 为急停。')

    # ------------------------------------------------------------------ UI
    def apply_dark_titlebar(self):
        try:
            self.root.update_idletasks()
            hwnd = ctypes.windll.user32.GetParent(self.root.winfo_id())
            if not hwnd:
                hwnd = self.root.winfo_id()
            value = ctypes.c_int(1)
            dwm = ctypes.windll.dwmapi
            for attr in (20, 19):
                if dwm.DwmSetWindowAttribute(hwnd, attr, ctypes.byref(value), 4) == 0:
                    break
        except Exception:
            pass

    def _build_ui(self):
        bg = '#070b11'
        panel = '#0f1722'
        panel2 = '#141f2c'
        edge = '#223247'
        text = '#e8f0f7'
        muted = '#8194a8'
        accent = '#2ee6c5'
        orange = '#ff9a4d'
        green = '#4ade80'
        red = '#ff5c76'
        font = ("Microsoft YaHei UI", 9)
        bold = ("Microsoft YaHei UI", 9, "bold")

        self.root.configure(bg=bg)
        self.root.geometry('1180x780')
        self.root.minsize(1040, 700)
        self.root.option_add('*TCombobox*Listbox.background', panel2)
        self.root.option_add('*TCombobox*Listbox.foreground', text)
        self.root.option_add('*TCombobox*Listbox.selectBackground', accent)
        self.root.option_add('*TCombobox*Listbox.selectForeground', '#041016')

        style = ttk.Style(self.root)
        try:
            style.theme_use('clam')
        except tk.TclError:
            pass
        style.configure('.', background=bg, foreground=text, font=font)
        style.configure('TFrame', background=panel)
        style.configure('TLabel', background=panel, foreground=text, font=font)
        style.configure('Muted.TLabel', background=panel, foreground=muted, font=font)
        style.configure('TButton', background=panel2, foreground=text, bordercolor=edge,
                        lightcolor=panel2, darkcolor=panel2, relief='flat',
                        padding=(10, 7), font=font)
        style.map('TButton',
                  background=[("active", "#1d3042"), ("pressed", "#263b50"),
                              ("disabled", "#111a24")],
                  foreground=[("disabled", "#526479")])
        style.configure('Accent.TButton', background=accent, foreground='#041016',
                        bordercolor=accent, lightcolor=accent, darkcolor=accent,
                        relief='flat', padding=(11, 7), font=bold)
        style.map("Accent.TButton", background=[("active", "#78f5dd"), ("pressed", "#16bfa5")])
        style.configure('Start.TButton', background=accent, foreground='#041016',
                        bordercolor=accent, lightcolor=accent, darkcolor=accent,
                        relief="flat", padding=(14, 11), font=("Microsoft YaHei UI", 10, "bold"))
        style.map("Start.TButton", background=[("active", "#78f5dd"), ("pressed", "#16bfa5")])
        style.configure('Danger.TButton', background='#2b1520', foreground='#ff8293',
                        bordercolor='#4a2230', padding=(10, 7), font=bold)
        style.map("Danger.TButton", background=[("active", "#3b1b28")])
        style.configure('TCheckbutton', background=panel, foreground=text, font=font,
                        indicatorcolor=panel2, indicatorrelief='flat')
        style.map('TCheckbutton',
                  background=[('active', panel)],
                  foreground=[('disabled', muted)],
                  indicatorcolor=[("selected", accent), ("active", "#1d3042")])
        style.configure('TEntry', fieldbackground=panel2, foreground=text,
                        insertcolor=accent, bordercolor=edge, lightcolor=panel2,
                        darkcolor=panel2, padding=5)
        style.configure('TCombobox', fieldbackground=panel2, background=panel2,
                        foreground=text, arrowcolor=accent, bordercolor=edge,
                        lightcolor=panel2, darkcolor=panel2, padding=4)
        style.map('TCombobox',
                  fieldbackground=[('readonly', panel2)],
                  foreground=[('readonly', text)],
                  selectbackground=[('readonly', panel2)],
                  selectforeground=[('readonly', text)])
        style.configure('TLabelframe', background=panel, foreground=text)
        style.configure('TLabelframe.Label', background=panel, foreground=muted, font=bold)
        style.configure('Vertical.TScrollbar', background=panel2, troughcolor=panel,
                        bordercolor=panel, arrowcolor=muted)

        def panel_box(parent, title, subtitle=""):
            box = tk.Frame(parent, bg=panel, highlightbackground=edge, highlightthickness=1)
            head = tk.Frame(box, bg=panel)
            head.pack(fill='x', padx=12, pady=(10, 0))
            tk.Label(head, text=title, bg=panel, fg=text, font=("Microsoft YaHei UI", 10, "bold")).pack(side="left")
            if subtitle:
                tk.Label(head, text=subtitle, bg=panel, fg=muted, font=("Consolas", 8)).pack(side="right")
            body = tk.Frame(box, bg=panel)
            body.pack(fill='both', expand=True, padx=12, pady=(7, 10))
            return box, body

        # ---------------------------------------------------------------- status vars
        self.game_var = tk.StringVar(value='等待游戏')
        self.defense_var = tk.StringVar(value='防御未连接')
        self.hp_var = tk.StringVar(value='HP: --')
        self.counter_var = tk.StringVar(value='格挡 0 / 闪避 0')
        self.enemy_var = tk.StringVar(value='敌人: --  最近: --  锁定: --')

        def check(parent, label, var, command=None, **pack_opts):
            cb = tk.Checkbutton(
                parent, text=label, variable=var, command=command,
                bg=panel, fg=text, activebackground=panel, activeforeground=accent,
                selectcolor='#12333b', font=font, anchor='w', justify='left',
                highlightthickness=0, bd=0, padx=0, pady=2, cursor='hand2',
            )
            cb.pack(**pack_opts)
            return cb

        # ---------------------------------------------------------------- header
        header = tk.Frame(self.root, bg=bg)
        header.pack(fill='x', padx=18, pady=(14, 6))
        brand = tk.Frame(header, bg=bg)
        brand.pack(side='left')
        logo = tk.Canvas(brand, width=42, height=42, bg=bg, highlightthickness=0)
        logo.pack(side='left', padx=(0, 11))
        logo.create_rectangle(2, 2, 40, 40, fill=accent, outline='')
        logo.create_text(21, 20, text="SB", fill="#041016", font=("Bahnschrift SemiBold", 16))
        title_box = tk.Frame(brand, bg=bg)
        title_box.pack(side='left')
        tk.Label(title_box, text='SB COMBAT ASSISTANT', bg=bg, fg=text,
                 font=("Bahnschrift SemiBold", 17)).pack(anchor="w")
        tk.Label(title_box, text='STELLAR BLADE  /  实时战斗副官', bg=bg, fg=muted,
                 font=("Consolas", 8)).pack(anchor="w", pady=(2, 0))
        chips = tk.Frame(header, bg=bg)
        chips.pack(side='right')
        for var in (self.game_var, self.defense_var, self.hp_var):
            tk.Label(chips, textvariable=var, bg=panel2, fg=muted, padx=12, pady=7,
                     font=("Consolas", 9)).pack(side="left", padx=4)

        main = tk.Frame(self.root, bg=bg)
        main.pack(fill='both', expand=True, padx=18, pady=(4, 14))
        main.grid_columnconfigure(0, weight=0, minsize=342)
        main.grid_columnconfigure(1, weight=1)
        main.grid_rowconfigure(0, weight=1)
        left = tk.Frame(main, bg=bg)
        left.grid(row=0, column=0, sticky='nsew', padx=(0, 12))
        right = tk.Frame(main, bg=bg)
        right.grid(row=0, column=1, sticky='nsew')

        # ---------------------------------------------------------------- live status
        status_box, status = panel_box(left, '战斗态势', 'LIVE TELEMETRY')
        status_box.pack(fill='x', pady=(0, 10))
        status.grid_columnconfigure(1, weight=1)
        tk.Label(status, text='生命值', bg=panel, fg=muted, font=font).grid(row=0, column=0, sticky='w')
        tk.Label(status, textvariable=self.hp_var, bg=panel, fg=accent,
                 font=("Bahnschrift", 16, "bold")).grid(row=0, column=1, sticky="e")
        self.hp_canvas = tk.Canvas(status, height=8, bg=panel2, highlightthickness=0)
        self.hp_canvas.grid(row=1, column=0, columnspan=2, sticky='ew', pady=(4, 10))
        self.hp_fill = self.hp_canvas.create_rectangle(0, 0, 0, 8, fill=accent, outline='')
        self.game_label = tk.Label(status, textvariable=self.game_var, bg=panel, fg=muted, font=font)
        self.game_label.grid(row=2, column=0, sticky='w')
        self.defense_label = tk.Label(status, textvariable=self.defense_var, bg=panel, fg=muted, font=font)
        self.defense_label.grid(row=2, column=1, sticky='e')
        tk.Label(status, textvariable=self.enemy_var, bg=panel, fg=text, font=font,
                 wraplength=300, justify='left', anchor='w').grid(
            row=3, column=0, columnspan=2, sticky='ew', pady=(8, 4))
        tk.Label(status, textvariable=self.counter_var, bg=panel, fg=muted,
                 font=("Consolas", 8), wraplength=300, justify="left", anchor="w").grid(
            row=4, column=0, columnspan=2, sticky='ew')
        tk.Label(status, textvariable=self.tactic_var, bg=panel, fg=orange, font=bold,
                 wraplength=300, justify='left', anchor='w').grid(
            row=5, column=0, columnspan=2, sticky='ew', pady=(9, 0))
        self.vision_text_var = tk.StringVar(value='视觉血条: --')
        tk.Label(status, textvariable=self.vision_text_var, bg=panel, fg=muted,
                 font=("Consolas", 8), anchor="w").grid(
            row=6, column=0, columnspan=2, sticky='ew', pady=(5, 0))

        # ---------------------------------------------------------------- defense
        self.guard_var = tk.BooleanVar(value=True)
        self.dodge_var = tk.BooleanVar(value=True)
        self.special_var = tk.BooleanVar(value=True)
        self.vision_var = tk.BooleanVar(value=False)
        defense_box, defense = panel_box(left, '自动防御', 'FRIDA NATIVE')
        defense_box.pack(fill='x', pady=(0, 10))
        check(defense, '自动格挡 / 完美招架', self.guard_var, anchor='w', pady=2)
        check(defense, '自动闪避', self.dodge_var, anchor='w', pady=2)
        check(defense, '自动闪现 / 击退', self.special_var, anchor='w', pady=2)
        check(defense, '视觉血条（实验）', self.vision_var, self.on_vision_toggle, anchor='w', pady=2)
        row = tk.Frame(defense, bg=panel)
        row.pack(fill='x', pady=(7, 0))
        ttk.Button(row, text='应用防御设置', command=self.apply_defense, style='Accent.TButton').pack(side='left')
        ttk.Button(row, text='F7 急停', command=self.emergency_stop, style='Danger.TButton').pack(side='right')

        # ---------------------------------------------------------------- extras
        extras_box, extras = panel_box(left, '扩展模块', 'TOOLS')
        extras_box.pack(fill='both', expand=True)
        extras.grid_columnconfigure(0, weight=1)
        extras.grid_columnconfigure(1, weight=1)
        extra_buttons = [
            ('无限弹药  F6', self.apply_ammo_patch),
            ('最高掉宝率', self.toggle_drop),
            ('游戏 HUD  F2', self.toggle_game_hud),
            ('抓取地图  F3', self.capture_game_map),
            ('悬浮地图  F4', self.open_guide_map),
            ('大地图', self.open_big_map),
            ('HUD 标定', self.open_hud_calibration),
        ]
        for i, (label, command) in enumerate(extra_buttons):
            ttk.Button(extras, text=label, command=command).grid(
                row=i // 2, column=i % 2, sticky='ew', padx=3, pady=3)
        self.drop_var = tk.StringVar(value='最高掉宝率：未知')
        tk.Label(extras, textvariable=self.drop_var, bg=panel, fg=muted, font=("Consolas", 8),
                 anchor='w', justify='left', wraplength=300).grid(
            row=4, column=0, columnspan=2, sticky='ew', pady=(7, 0))

        # ---------------------------------------------------------------- control
        control_box, control = panel_box(right, '自动战斗', 'ENGAGE CONTROL')
        control_box.pack(fill='x', pady=(0, 10))
        self.start_btn = ttk.Button(control, text='开始自动战斗 (F9)', command=self.toggle_combo,
                                    style='Start.TButton')
        self.start_btn.pack(fill='x', pady=(0, 7))
        quick = tk.Frame(control, bg=panel)
        quick.pack(fill='x', pady=(0, 8))
        ttk.Button(quick, text='打一套  F8', command=self.test_once).pack(side='left')
        ttk.Button(quick, text='停止 / 急停  F7', command=self.emergency_stop,
                   style='Danger.TButton').pack(side='left', padx=6)
        tk.Label(quick, text='锁定后自动接敌 · 无需等待', bg=panel, fg=muted, font=font).pack(side='right')

        combo_line = tk.Frame(control, bg=panel)
        combo_line.pack(fill='x', pady=(0, 7))
        tk.Label(combo_line, text='连招覆盖', bg=panel, fg=muted, font=font).pack(side='left', padx=(0, 7))
        self.combo_box = ttk.Combobox(combo_line, values=self.combo_names, state='readonly', width=22)
        self.combo_box.set(self.combo_names[self.combo_state['combo_index']])
        self.combo_box.pack(side='left')
        self.combo_box.bind('<<ComboboxSelected>>', self.on_combo_change)
        tk.Label(combo_line, text='自动战斗时按局势动态评分', bg=panel, fg=muted,
                 font=("Consolas", 8)).pack(side="left", padx=10)

        opts = tk.Frame(control, bg=panel)
        opts.pack(fill='x', pady=(0, 7))
        self.potion_var = tk.BooleanVar(value=True)
        self.auto_engage_var = tk.BooleanVar(value=self.auto_engage)
        check(opts, '锁定后自动战斗', self.auto_engage_var, self.apply_auto, side='left')
        check(opts, '自动喝药', self.potion_var, self.on_potion_toggle, side='left', padx=14)
        tk.Label(opts, text='阈值', bg=panel, fg=muted, font=font).pack(side='left', padx=(6, 2))
        self.threshold_var = tk.StringVar(value='35')
        ttk.Entry(opts, textvariable=self.threshold_var, width=4).pack(side='left')
        tk.Label(opts, text='% 按 Q', bg=panel, fg=muted, font=font).pack(side='left', padx=(2, 0))

        fields = tk.Frame(control, bg=panel)
        fields.pack(fill='x', pady=(2, 0))
        for c in (1, 3, 5, 7):
            fields.grid_columnconfigure(c, weight=1)
        tk.Label(fields, text='攻击距离', bg=panel, fg=muted, font=font).grid(row=0, column=0, sticky='w')
        self.range_var = tk.StringVar(value=str(self.attack_range))
        ttk.Entry(fields, textvariable=self.range_var, width=6).grid(row=0, column=1, sticky='w', padx=(4, 12))
        tk.Label(fields, text='每步间隔 ms', bg=panel, fg=muted, font=font).grid(row=0, column=2, sticky='w')
        self.interval_var = tk.StringVar(value=str(self.cfg['step_interval_ms']))
        ttk.Entry(fields, textvariable=self.interval_var, width=6).grid(row=0, column=3, sticky='w', padx=(4, 12))
        tk.Label(fields, text='整套停顿 ms', bg=panel, fg=muted, font=font).grid(row=0, column=4, sticky='w')
        self.pause_var = tk.StringVar(value=str(self.cfg['combo_end_pause_ms']))
        ttk.Entry(fields, textvariable=self.pause_var, width=6).grid(row=0, column=5, sticky='w', padx=(4, 12))
        tk.Label(fields, text='每 N 套贝塔', bg=panel, fg=muted, font=font).grid(row=0, column=6, sticky='w')
        self.beta_var = tk.StringVar(value=str(self.cfg.get('beta_every_cycles', 0)))
        ttk.Entry(fields, textvariable=self.beta_var, width=5).grid(row=0, column=7, sticky='w', padx=(4, 6))
        ttk.Button(fields, text='保存', command=self.save_settings).grid(row=0, column=8, padx=(4, 0))

        # ---------------------------------------------------------------- log
        log_box, log_body = panel_box(right, '战斗日志', 'LIVE LOG')
        log_box.pack(fill='both', expand=True)
        log_head = tk.Frame(log_body, bg=panel)
        log_head.pack(fill='x', pady=(0, 5))
        tk.Button(log_head, text='清空', command=self.clear_log, bg=panel2, fg=muted,
                  activebackground=edge, activeforeground=text, relief='flat',
                  font=("Consolas", 8), padx=8, pady=2).pack(side="right")
        self.log_text = tk.Text(log_body, wrap='word', state='disabled', bg='#0b131c',
                                fg=text, insertbackground=accent, selectbackground='#173044',
                                selectforeground=text, relief='flat', borderwidth=0,
                                font=("Consolas", 9), padx=10, pady=8, spacing1=1, spacing3=1)
        scroll = ttk.Scrollbar(log_body, orient='vertical', command=self.log_text.yview)
        self.log_text.configure(yscrollcommand=scroll.set)
        self.log_text.pack(side='left', fill='both', expand=True)
        scroll.pack(side='right', fill='y')
        self.log_text.tag_configure('info', foreground='#b8c7d9')
        self.log_text.tag_configure('ok', foreground=green)
        self.log_text.tag_configure('warn', foreground=orange)
        self.log_text.tag_configure('err', foreground=red)

        footer = tk.Frame(right, bg=bg)
        footer.pack(fill='x', pady=(8, 0))
        tk.Label(footer, text='F9 开战    F8 单套    F7 急停    F6 弹药    F2 HUD    F3 抓图    F4 地图',
                 bg=bg, fg="#5c7086", font=("Consolas", 8)).pack(anchor="w")

    def clear_log(self):
        self.log_text.configure(state='normal')
        self.log_text.delete('1.0', 'end')
        self.log_text.configure(state='disabled')

    def _update_hp_bar(self, snap):
        if not hasattr(self, 'hp_canvas'):
            return
        w = self.hp_canvas.winfo_width()
        if w <= 1:
            w = 280
        ratio = 0.0
        color = '#173044'
        if snap.get('hp_valid') and int(snap.get('max_hp') or 0) > 0:
            ratio = max(0.0, min(1.0, float(snap.get('hp') or 0) / float(snap['max_hp'])))
            color = '#4ade80' if ratio > 0.5 else ('#ff9a4d' if ratio > 0.25 else '#ff5c76')
        self.hp_canvas.coords(self.hp_fill, 0, 0, int(w * ratio), 8)
        self.hp_canvas.itemconfigure(self.hp_fill, fill=color)

    # ------------------------------------------------------------- actions
    def log(self, message):
        self.log_queue.put("[%s] %s" % (time.strftime("%H:%M:%S"), message))

    def on_potion_toggle(self):
        self.auto_potion = bool(self.potion_var.get())
        self.log('自动喝药：%s')

    def state_dir(self):
        path = self.cfg.get('auto_state_path') or DEFAULT_STATE_PATH
        return os.path.dirname(path)

    def toggle_drop(self):
        try:
            result = drop_patch.apply_drop_rate_patch()
            if result.get('ok'):
                self.log('最高掉宝率补丁已启用 @ %s')
            else:
                # The native pattern moves between game hotfixes.  The Lua
                # table mutation below is the reliable fallback and still
                # covers every DropRateAdjustTable/RewardGroupTable row.
                self.log('掉宝率原生补丁未命中，改用 Lua 表修改')
        except Exception as exc:
            self.log('掉宝率补丁异常: %s')
        try:
            path = os.path.join(self.state_dir(), 'drop_command.txt')
            with open(path, 'w', encoding='utf-8') as f:
                f.write('toggle %f\n' % time.time())
            self.log('请求切换最高掉宝率')
        except Exception as exc:
            self.log('掉宝率切换失败: %s')

    def request_map_toggle(self):
        self.map_toggle_requested = True

    def apply_ammo_patch(self):
        try:
            result = ammo_patch.apply_ammo_patch()
            p1 = result.get('p1') or {}
            p2 = result.get('p2') or {}
            if result.get('ok'):
                self.log('无限弹药/物品不减补丁已启用')
            else:
                self.log('无限弹药补丁: p1=' % (
                    p1.get("error") or p1.get("ok"), p2.get("error") or p2.get("ok")))
        except Exception as exc:
            self.log('无限弹药补丁异常: %s')

    def open_guide_map(self):
        try:
            if self.map_server is None:
                map_dir = os.path.join(base_dir(), 'mapviewer')
                if not os.path.isdir(map_dir):
                    self.log('攻略地图缺少 mapviewer 文件夹')
                    return
                self.map_server = guide_map.MapServer(map_dir, self.log)
            self.guide_process = self.map_server.open_map(97, hud=True)
            self.log('悬浮地图已打开（小窗置顶，F4 可再开）')
        except Exception as exc:
            self.log('悬浮地图打开失败: %s')

    def open_big_map(self):
        try:
            if self.map_server is None:
                map_dir = os.path.join(base_dir(), 'mapviewer')
                if not os.path.isdir(map_dir):
                    self.log('攻略地图缺少 mapviewer 文件夹')
                    return
                self.map_server = guide_map.MapServer(map_dir, self.log)
            self.guide_process = self.map_server.open_map(97, hud=False)
            self.log('大地图已打开')
        except Exception as exc:
            self.log('大地图打开失败: %s')

    def toggle_game_hud(self):
        if self.game_hud is not None:
            self.game_hud.destroy()
            self.game_hud = None
            self.log('游戏地图 HUD 已关闭')
            return
        map_path = os.path.join(base_dir(), 'mapviewer', 'data', 'game_map.png')
        if not os.path.isfile(map_path):
            self.log('还没有 game_map.png，请先按 M 打开地图再按 F3 抓图')
            return
        try:
            self.game_hud = game_hud.GameMapHud(
                self.root, map_path, self.cfg.get('auto_state_path') or DEFAULT_STATE_PATH,
                os.path.join(base_dir(), 'mapviewer', 'data', 'game_hud_calibration.json'))
            self.game_hud.update()
            self.log('游戏地图 HUD 已打开（Xion 底图）')
        except Exception as exc:
            self.game_hud = None
            self.log('游戏地图 HUD 打开失败: %s')

    def open_hud_calibration(self):
        map_path = os.path.join(base_dir(), 'mapviewer', 'data', 'game_map.png')
        if not os.path.isfile(map_path):
            self.log('还没有 game_map.png，请先按 M 打开地图再按 F3 抓图')
            return
        try:
            game_hud.CalibrationWindow(
                self.root, map_path,
                self.cfg.get('auto_state_path') or DEFAULT_STATE_PATH,
                os.path.join(base_dir(), 'mapviewer', 'data', 'game_hud_calibration.json'),
                on_saved=self.on_hud_calibrated, log=self.log)
        except Exception as exc:
            self.log('HUD 标定窗口打开失败: %s')

    def on_hud_calibrated(self):
        if self.game_hud is not None:
            self.game_hud.reload_calibration()
            self.game_hud.update()

    def capture_game_map(self):
        try:
            path = os.path.join(base_dir(), 'mapviewer', 'data', 'game_map.png')
            os.makedirs(os.path.dirname(path), exist_ok=True)
            script = os.path.join(base_dir(), 'mapviewer', 'capture_game.ps1')
            if os.path.isfile(script):
                subprocess.run(
                    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass',
                     '-File', script, '-Out', path],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    timeout=20, check=False)
                self.log('游戏窗口截图已保存（不含其他窗口）: %s')
                return
            # Fallback: full desktop capture.
            ps = (
                "Add-Type -AssemblyName System.Windows.Forms;Add-Type -AssemblyName System.Drawing;$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);$bmp.Save('%s',[System.Drawing.Imaging.ImageFormat]::Png);$g.Dispose();$bmp.Dispose()"
                "Add-Type -AssemblyName System.Drawing;"
                "$b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds;"
                "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
                "$g=[System.Drawing.Graphics]::FromImage($bmp);"
                "$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);"
                "$bmp.Save('%s',[System.Drawing.Imaging.ImageFormat]::Png);"
                "$g.Dispose();$bmp.Dispose()" % path.replace("'", "''")
            )
            subprocess.run(['powershell', '-NoProfile', '-Command', ps],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=15, check=False)
            self.log('游戏地图截图已保存: %s')
        except Exception as exc:
            self.log('抓取游戏地图失败: %s')

    def set_map_visible(self, visible):
        if visible and self.map_window is None:
            win = tk.Toplevel(self.root)
            win.overrideredirect(True)
            win.attributes('-topmost', True)
            win.attributes('-alpha', 0.92)
            try:
                win.wm_attributes('-transparentcolor', '#000000')
            except Exception:
                pass
            size = 300
            screen_w = win.winfo_screenwidth()
            win.geometry('%dx%d+%d+%d' % (size, size, max(0, screen_w - size - 30), 40))
            canvas = tk.Canvas(win, width=size, height=size, bg='#000000', highlightthickness=0)
            canvas.pack(fill='both', expand=True)
            self.map_window = win
            self.map_canvas = canvas
            self._make_clickthrough(win)
            self.log('实时地图已打开（F4 关闭）')
        elif not visible and self.map_window is not None:
            try:
                self.map_window.destroy()
            except Exception:
                pass
            self.map_window = None
            self.map_canvas = None
            self.log('实时地图已关闭')

    def _make_clickthrough(self, win):
        try:
            hwnd = ctypes.windll.user32.GetParent(win.winfo_id())
            gwl = -20
            style = ctypes.windll.user32.GetWindowLongW(hwnd, gwl)
            ctypes.windll.user32.SetWindowLongW(hwnd, gwl, style | 0x00080000 | 0x00000020)
        except Exception:
            pass

    def draw_map(self):
        canvas = self.map_canvas
        if canvas is None:
            return
        canvas.delete('all')
        size = 300
        center = size / 2
        radius = 132
        if not self.auto_state or time.time() - self.auto_state_at > 1.5:
            canvas.create_text(center, center, text='等待游戏状态', fill='#9ca3af')
            return
        state = self.auto_state
        player = state.get('player') or [0, 0, 0]
        px, py = float(player[0]), float(player[1])
        yaw = float(state.get('yaw') or 0.0)

        canvas.create_oval(center - radius, center - radius, center + radius, center + radius,
                           outline='#1f6feb', width=2)
        canvas.create_oval(center - radius / 2, center - radius / 2, center + radius / 2, center + radius / 2,
                           outline='#1e3a5f', width=1)
        canvas.create_line(center, center - radius, center, center + radius, fill='#1e3a5f')
        canvas.create_line(center - radius, center, center + radius, center, fill='#1e3a5f')
        canvas.create_text(center, 12, text='N', fill='#93c5fd')
        canvas.create_text(center, size - 12, text='S', fill='#64748b')
        canvas.create_text(12, center, text='W', fill='#64748b')
        canvas.create_text(size - 12, center, text='E', fill='#64748b')

        scale = 2600.0 / radius
        for actor in state.get('actors') or []:
            try:
                dx = float(actor.get('x', 0)) - px
                dy = float(actor.get('y', 0)) - py
            except (TypeError, ValueError):
                continue
            if abs(dx) > 2600 or abs(dy) > 2600:
                continue
            x = center + dx / scale
            y = center - dy / scale
            canvas.create_oval(x - 3, y - 3, x + 3, y + 3, fill='#ef4444', outline='')

        # player as a triangle pointing along yaw (UE X forward, Y right)
        import math as _math
        rad = _math.radians(yaw)
        fx = _math.sin(rad)
        fy = _math.cos(rad)
        right_x = fy
        right_y = -fx
        tip = (center + fx * 10, center - fy * 10)
        left = (center - fx * 6 - right_x * 5, center + fy * 6 + right_y * 5)
        right = (center - fx * 6 + right_x * 5, center + fy * 6 - right_y * 5)
        canvas.create_polygon(tip[0], tip[1], left[0], left[1], right[0], right[1], fill='#22d3ee', outline='')

        locked = bool(state.get('locked'))
        canvas.create_text(center, size - 24,
                           text='锁定: %s' % ('是' if locked else '否'),
                           fill='#fbbf24' if locked else '#9ca3af')

    def apply_auto(self):
        self.auto_engage = bool(self.auto_engage_var.get())
        try:
            attack_range = int(self.range_var.get())
        except ValueError:
            attack_range = 300
        if attack_range < 50:
            attack_range = 50
        self.attack_range = attack_range
        self.cfg['auto_engage'] = self.auto_engage
        self.cfg['attack_range'] = attack_range
        ac.save_config(self.cfg)
        self.emergency = False
        if self.auto_engage:
            self.combo_on = True
            self.combo_state['running'] = True
        else:
            self.combo_on = False
            self.combo_state['running'] = False
            self.set_forward(False)
        self.log('锁定自动战斗：%s，攻击距离=%d')

    def set_forward(self, down):
        # Auto-combat never moves the character. Walking stays fully manual.
        return

    def recover_stuck(self):
        # Auto-combat never moves the character, so there is no stuck recovery.
        return

    def current_combo(self):
        return self.combo_names[self.combo_state['combo_index']]

    def on_combo_change(self, _event=None):
        name = self.combo_box.get()
        if name in self.combo_names:
            self.combo_state['combo_index'] = self.combo_names.index(name)
            self.cfg['active_combo'] = name
            ac.save_config(self.cfg)
            self.log('切换连招：%s')

    def advance_combo(self):
        self.combo_state['combo_index'] = (self.combo_state['combo_index'] + 1) % len(self.combo_names)
        self.cfg['active_combo'] = self.current_combo()
        ac.save_config(self.cfg)
        self.log('切换连招：%s')

    def apply_defense(self):
        guard = bool(self.guard_var.get())
        dodge = bool(self.dodge_var.get())
        special = bool(self.special_var.get())
        if not (guard or dodge or special):
            self.log('防御全部关闭，仅保留 HP 观察')
        self.emergency = False
        self.engine.set_flags(guard, dodge, special)
        if self.auto_engage:
            self.combo_on = True
            self.combo_state['running'] = True
        self.log('应用防御：格挡=')

    def toggle_combo(self):
        if self.emergency:
            self.log('急停状态，请先点“应用防御设置”恢复')
            return
        self.combo_on = not self.combo_on
        self.combo_state['running'] = self.combo_on
        self.combo_state['once'] = False
        if not self.combo_on:
            self.set_forward(False)
        self.log('开始自动战斗' if self.combo_on else '停止自动战斗')

    def test_once(self):
        if self.combo_on:
            self.log('自动战斗中，先按 F9 停止再试单套')
            return
        self.combo_state['once'] = True
        self.log('单套：%s')

    def save_settings(self):
        try:
            interval = int(self.interval_var.get())
            pause = int(self.pause_var.get())
            beta = int(self.beta_var.get())
            threshold = int(self.threshold_var.get())
        except ValueError:
            messagebox.showerror('设置错误', '间隔/停顿/贝塔/血量必须是整数')
            return
        if interval < 30 or pause < 0 or beta < 0 or not (1 <= threshold <= 99):
            messagebox.showerror("设置错误", "间隔至少 30ms，血量 1-99")
            return
        self.cfg["step_interval_ms"] = interval
        self.cfg["combo_end_pause_ms"] = pause
        self.cfg['step_interval_ms'] = beta
        self.threshold = threshold
        ac.save_config(self.cfg)
        self.log("设置已保存：间隔=%dms 停顿=%dms 贝塔每%d套 喝药<%d%%" % (
                 interval, pause, beta, threshold))

    def emergency_stop(self):
        self.emergency = True
        self.combo_on = False
        self.combo_state["running"] = False
        self.combo_state["once"] = False
        self.set_forward(False)
        self.engine.set_enabled(False)
        self.log('F7 急停：连招停止，防御引擎卸载')

    def on_close(self):
        self.emergency = True
        self.combo_on = False
        self.combo_state["stop"] = True
        self.set_forward(False)
        if self.map_window is not None:
            try:
                self.map_window.destroy()
            except Exception:
                pass
            self.map_window = None
            self.map_canvas = None
        if self.map_server is not None:
            try:
                self.map_server.stop()
            except Exception:
                pass
        if self.game_hud is not None:
            try:
                self.game_hud.destroy()
            except Exception:
                pass
            self.game_hud = None
        try:
            self.vision_reader.stop()
        except Exception:
            pass
        if self.guide_process is not None:
            try:
                self.guide_process.terminate()
            except Exception:
                pass
        self.engine.shutdown()
        try:
            ac.save_config(self.cfg)
        except Exception:
            pass
        self.root.destroy()

    # -------------------------------------------------------------- threads
    def _start_threads(self):
        threading.Thread(target=self.state_worker, daemon=True).start()
        threading.Thread(target=self.combo_worker, daemon=True).start()
        threading.Thread(target=self.potion_worker, daemon=True).start()
        threading.Thread(target=self.hotkey_worker, daemon=True).start()

    def state_worker(self):
        while not self.combo_state["stop"]:
            path = self.cfg.get("auto_state_path") or DEFAULT_STATE_PATH
            try:
                mtime = os.path.getmtime(path)
                if time.time() - mtime < 1.5:
                    with open(path, "r", encoding="utf-8-sig") as f:
                        data = json.load(f)
                    if data.get("ok"):
                        self.auto_state = data
                        self.auto_state_at = time.time()
                        count = int(data.get("enemy_count") or 0)
                        if count != self.last_enemy_count:
                            self.last_enemy_count = count
                            if count > 0:
                                nearest = data.get("nearest") or {}
                                self.log('发现 %d 个怪，最近距离 %.0f')
                            else:
                                self.log('周围没有怪，自动战斗待机')
                elif self.last_enemy_count > 0:
                    self.last_enemy_count = 0
                    self.auto_state = {}
                    self.log('怪物状态过期，自动战斗待机')
            except Exception:
                pass
            time.sleep(0.2)

    def auto_interrupted(self):
        state = self.auto_state
        if not state or time.time() - self.auto_state_at > 0.9:
            return True
        if not state.get("locked") or not state.get("lock_target"):
            return True
        if state.get("parried"):
            return True
        if state.get("paused") or state.get("move_ignored"):
            return True
        return False

    def run_auto_combo(self, name, end_pause_ms=None):
        steps = self.cfg["combos"].get(name)
        if not steps:
            return False
        interval = self.cfg["step_interval_ms"] / 1000.0
        for item in steps:
            if self.emergency or not self.combo_on or self.combo_state['step_interval_ms']:
                return False
            if self.auto_interrupted():
                return False
            if self.auto_engage and self.gap_close_enabled and self.auto_state:
                try:
                    live_dist = float(self.auto_state.get("lock_dist") or 0)
                except (TypeError, ValueError):
                    live_dist = 0.0
                if live_dist > self.gap_interrupt_distance:
                    return False
            with_key = item.get("with")
            hold_ms = int(item.get("hold_ms", 30))
            if item.get("key") == "heavy" and hold_ms < 55:
                # A 30 ms RMB pulse can be swallowed during light-attack
                # recovery; the result is visually "only light attacks".
                hold_ms = 55
            if with_key:
                ac.send_key(self.cfg["keys"][with_key], True)
            ac.tap(self.cfg["keys"][item["key"]], hold_ms)
            if with_key:
                ac.send_key(self.cfg["keys"][with_key], False)
            time.sleep(ac.combo_step_delay(item, self.cfg.get("step_interval_ms", 140)))
        if end_pause_ms is None:
            end_pause = int(self.cfg.get('step_interval_ms') or 380)
            if name in ("onslaught_ii", "onslaught_iii"):
                end_pause = min(end_pause, int(self.cfg.get('combo_end_pause_ms') or 260))
        else:
            end_pause = int(end_pause_ms)
        if end_pause > 0:
            time.sleep(end_pause / 1000.0)
        return True

    def target_state(self):
        ts = (self.auto_state or {}).get("target_state") or {}
        return ts if isinstance(ts, dict) else {}

    def execution_window(self):
        if not self.combo_on or self.emergency:
            return False
        ts = self.target_state()
        if not (ts.get("groggy") or ts.get("tired")):
            return False
        if time.time() - self.last_execution < 1.6:
            return False
        try:
            dist = float((self.auto_state or {}).get("lock_dist") or 0)
        except (TypeError, ValueError):
            dist = 0.0
        return dist <= self.attack_range

    def combo_profile(self, name):
        steps = self.cfg["combos"].get(name) or []
        keys = [str(item.get("key") or "") for item in steps if isinstance(item, dict)]
        holds = [int(item.get('combos', 0) or 0) for item in steps if isinstance(item, dict)]
        return {
            'hold_ms': len(keys),
            "heavy": sum(1 for k in keys if k == "heavy"),
            "light": sum(1 for k in keys if k == "light"),
            'heavy': max(holds) if holds else 0,
            "mobility": any(k in ("dodge", "jump") for k in keys),
        }

    def infer_role(self):
        state = self.auto_state or {}
        ts = self.target_state()
        try:
            close_count = int(state.get("close_count") or 0)
            mid_count = int(state.get("mid_count") or 0)
            dist = float(state.get('close_count') or 0)
        except (TypeError, ValueError):
            close_count, mid_count, dist = 0, 0, 0.0
        if dist <= 0:
            try:
                dist = float((state.get("nearest") or {}).get("dist") or 0)
            except (TypeError, ValueError):
                dist = 0.0
        boss = bool(state.get("lock_boss") or (not state.get("locked") and state.get("nearest_boss")))
        hp_ratio = 1.0
        try:
            snap = self.engine.snapshot()
            if snap.get("hp_valid") and int(snap.get("max_hp") or 0) > 0:
                hp_ratio = float(snap.get("hp") or 0) / float(snap.get("max_hp") or 1)
        except Exception:
            hp_ratio = 1.0
        enemy_hp_ratio = 0.0
        try:
            enemy_max = float(ts.get("max_hp") or 0)
            if enemy_max > 0:
                enemy_hp_ratio = float(ts.get('max_hp') or 0) / enemy_max
        except (TypeError, ValueError):
            enemy_hp_ratio = 0.0
        try:
            if self.vision_var is not None and self.vision_var.get():
                vis = self.vision_reader.snapshot()
                if vis.get("ratio") is not None and float(vis.get("confidence") or 0) >= 0.55:
                    enemy_hp_ratio = float(vis["ratio"])
        except Exception:
            pass
        stance = str(ts.get("stance") or "").lower()
        if ts.get("groggy") or ts.get("tired"):
            return "punish"
        if stance and any(tag in stance for tag in ("shield", "armor", "guard", "break")):
            return "break"
        if hp_ratio < 0.32:
            return "defense"
        if ts.get("running") and not boss:
            return "danger"
        if boss:
            return "boss"
        if close_count >= 2 or mid_count >= 3:
            return "group"
        if dist >= 230:
            return "gap"
        if enemy_hp_ratio and enemy_hp_ratio < 0.28:
            return "execute"
        return "single"

    def choose_auto_combo(self, role_override=None, allowed=None, quiet=False):
        pool = [n for n in self.combo_deck if n not in ("counter_ii", "reflection")]
        if allowed is not None:
            allow = set(allowed)
            pool = [n for n in pool if n in allow]
        if not pool:
            pool = [self.current_combo()]
        state = self.auto_state or {}
        ts = self.target_state()
        try:
            enemy_count = int(state.get("enemy_count") or 1)
            close_count = int(state.get("close_count") or 0)
            mid_count = int(state.get('enemy_count') or 0)
            dist = float(state.get('close_count') or 0)
        except (TypeError, ValueError):
            enemy_count, close_count, mid_count, dist = 1, 0, 0, 0.0
        if dist <= 0:
            try:
                dist = float((state.get("nearest") or {}).get("dist") or 0)
            except (TypeError, ValueError):
                dist = 0.0
        boss = bool(state.get("lock_boss") or (not state.get("locked") and state.get("nearest_boss")))
        hp_ratio = 1.0
        try:
            snap = self.engine.snapshot()
            if snap.get("hp_valid") and int(snap.get("max_hp") or 0) > 0:
                hp_ratio = float(snap.get("hp") or 0) / float(snap.get("max_hp") or 1)
        except Exception:
            hp_ratio = 1.0

        stance = str(ts.get("stance") or "").lower()
        enemy_hp_ratio = 0.0
        try:
            enemy_max = float(ts.get("max_hp") or 0)
            if enemy_max > 0:
                enemy_hp_ratio = float(ts.get('max_hp') or 0) / enemy_max
        except (TypeError, ValueError):
            enemy_hp_ratio = 0.0
        try:
            if self.vision_var is not None and self.vision_var.get():
                vis = self.vision_reader.snapshot()
                if vis.get("ratio") is not None and float(vis.get("confidence") or 0) >= 0.55:
                    enemy_hp_ratio = float(vis["ratio"])
        except Exception:
            pass

        # Role is inferred from the live state, not a fixed combo table.  The
        # actual string is assembled below from a weighted score over every
        # unlocked combo, so the same situation does not always repeat.
        role = role_override or self.infer_role()

        weights = {}
        for name in pool:
            prof = self.combo_profile(name)
            n = prof["n"]
            heavy = prof["heavy"]
            hold = prof['n']
            finisher = 1 if hold >= 400 else 0
            score = 1.0
            if role == "punish":
                score += n * 0.9 + heavy * 0.8 + finisher * 0.7
            elif role == 'punish':
                score += heavy * 1.5 + finisher * 1.1 + n * 0.2
            elif role == 'break':
                score += n * 0.8 + heavy * 0.5
            elif role == 'group':
                score += 1.4 if (n <= 3 and not finisher) else 0.2
                score += 0.5 if prof['danger'] else 0.0
            elif role == "gap":
                if name in ("rush_chain", "rush"):
                    score += 2.4
                elif name.startswith("onslaught"):
                    score += 1.4
                else:
                    score += 0.1
            elif role == "boss":
                score += heavy * 1.1 + finisher * 0.9 + n * 0.3
            elif role == 'boss':
                score += (1.2 if (n <= 3 and not finisher) else 0.1)
                score += heavy * 0.3
            elif role == "execute":
                score += finisher * 1.0 + heavy * 0.8
            else:
                score += n * 0.3 + heavy * 0.4
            if name == "air_chain":
                score *= 0.28 if ts.get("groggy") else 0.04
            if name == 'air_chain':
                score *= 0.75
            if role == 'dodge_chain' and n < 2:
                score *= 0.06
            if role == 'punish' and heavy < 2:
                score *= 0.08
            if role == 'break' and n < 3:
                score *= 0.08
            if role == 'group' and (n > 3 or finisher):
                score *= 0.15
            if role == "gap" and name not in ("rush_chain", "rush"):
                score *= 0.32
            if role == "single" and name == "air_chain":
                score *= 0.05
            if self.recent_combos:
                if name == self.recent_combos[-1]:
                    score *= 0.22
                elif name in self.recent_combos[-3:]:
                    score *= 0.45
            weights[name] = max(0.05, score)

        names = list(weights)
        choices = [weights[n] for n in names]
        name = random.choices(names, weights=choices, k=1)[0]

        if not quiet and role != self.last_decision_role:
            self.last_decision_role = role
            labels = {"defense": "低血防守", "boss": "Boss 破防", "group": "群怪横扫",
                      "danger": "敌人出招/保守", "gap": "中距突进", "single": "单体压制",
                      "punish": "破韧惩罚", "break": "破盾/破甲", "execute": "残血收割"}
            self.log("局势：%s（敌%d 近%d 距%.0f）" % (labels.get(role, role), enemy_count, close_count, dist))
        self.decision_role = role
        self.recent_combos.append(name)
        if len(self.recent_combos) > 6:
            self.recent_combos.pop(0)
        return name

    def _pick_flow(self, role, names, avoid):
        pool = [
            n for n in names
            if n in self.cfg["combos"] and n in self.combo_deck and n not in avoid
        ]
        if not pool:
            pool = [
                n for n in self.combo_deck
                if n not in avoid and n not in ("counter_ii", "reflection")
            ]
        if not pool:
            return None
        return self.choose_auto_combo(role_override=role, allowed=pool, quiet=True)

    def finalize_flow_plan(self, plan, role):
        plan = [n for n in plan if n]
        if not plan:
            return []
        # Avoid showing the exact same three-string arc back-to-back.  The
        # weighted picker normally handles this, but a short allowed pool
        # (danger/gap) can otherwise lock onto one string for a whole fight.
        if plan == self.last_flow_plan and len(plan) >= 2:
            alt = self._pick_flow(role, FLOW_FINISHERS, plan[:-1])
            if alt and alt not in plan:
                plan[-1] = alt
        self.last_flow_plan = list(plan)
        return plan

    def build_flow_plan(self):
        """Build a 1-3 string arc instead of one isolated combo.

        The first slot is fast, the last slot is a committed/heavy or Beta
        finisher, and the middle slot keeps pressure.  Links are executed
        without the usual end-of-combo pause, which is what makes the output
        look like one continuous sequence rather than separate tool actions.
        """
        role = self.infer_role()
        if role == "defense":
            plan = [self._pick_flow(role, FLOW_DANGER, ())]
            return self.finalize_flow_plan(plan, role)
        if role == "danger":
            # An evasive opener alone is what made the character look like it
            # only used lights.  Always follow the dodge/mix opener with a
            # committed counter string so a running attack is punished.
            opener = self._pick_flow(role, FLOW_DANGER, tuple(self.last_flow_plan))
            counter = self._pick_flow(
                "punish",
                ("onslaught_iii", "incursion_iv", "breaker_chain", "onslaught_iv"),
                (opener,),
            )
            plan = [opener, counter]
            return self.finalize_flow_plan(plan, role)
        if role == "gap":
            plan = [self._pick_flow(role, ("rush_chain", "rush", "onslaught_iv"), ())]
            return self.finalize_flow_plan(plan, role)

        if role in ("punish", "group"):
            length = min(3, self.flow_max_segments)
        elif role in ("boss", "break", "execute"):
            length = 2
        else:
            length = 2
        if role in ("single", "boss", "break") and random.random() < 0.22:
            length = min(3, self.flow_max_segments)

        openers = FLOW_OPENERS
        if role in ("single", "group") and random.random() < 0.30:
            # Keep the arc from always being the same weapon string family.
            # Dodge/mix openers also make the openings read as deliberate
            # movement instead of a repeating attack preset.
            openers = ("mix_chain", "dodge_chain", "incursion_ii")
        if role == "punish" and random.random() < 0.22:
            openers = openers + ("air_chain",)
        first = self._pick_flow(role, openers, tuple(self.last_flow_plan))
        if not first:
            return []
        plan = [first]
        if length >= 2:
            last = self._pick_flow(role, FLOW_FINISHERS, plan)
            if last:
                plan.append(last)
        if length >= 3:
            middle = self._pick_flow(role, FLOW_LINKS, plan)
            if middle:
                plan.insert(1, middle)
        # Keep the finisher heavy/committed.  If the scored pick was a short
        # light string, try once more before accepting it.
        if len(plan) >= 2 and self.combo_profile(plan[-1])["heavy"] == 0:
            alt = self._pick_flow(role, FLOW_FINISHERS, plan[:-1])
            if alt and self.combo_profile(alt)['heavy'] > 0:
                plan[-1] = alt
        return self.finalize_flow_plan(plan, role)

    def run_flow_plan(self, plan):
        if not plan:
            return False
        self.flow_step = 0
        for index, name in enumerate(plan):
            self.flow_step = index + 1
            if index:
                if self.auto_interrupted():
                    return False
                # Deliberately shorter than a combo end pause: the next string
                # is buffered while the previous recovery animation finishes.
                time.sleep(max(0, self.flow_link_ms) / 1000.0)
            if not self.run_auto_combo(name, end_pause_ms=0):
                return False
        if self.flow_tail_ms > 0:
            time.sleep(self.flow_tail_ms / 1000.0)
        return True

    def use_beta(self, role=None):
        keys = [k for k in self.beta_keys if k]
        if not keys:
            return
        role_to_beta = {"group": "aoe", "boss": "control", "single": "burst",
                        "defense": "defense", "gap": "burst", "danger": "defense",
                        "execute": "control"}
        wanted = role_to_beta.get(role, role)
        candidates = [k for k in keys if wanted and (self.beta_roles or {}).get(k) == wanted]
        if not candidates:
            candidates = keys
        key = candidates[self.beta_index % len(candidates)]
        self.beta_index += 1
        self.log('贝塔技能 ')
        ac.tap(key, 30)
        self.last_beta = time.time()
        time.sleep(0.35)

    def use_burst(self, role=None):
        keys = [k for k in self.burst_keys if k]
        if not keys:
            return
        key = keys[self.burst_index % len(keys)]
        self.burst_index += 1
        self.log('爆发技能 ')
        ac.send_key(self.burst_modifier, True)
        time.sleep(0.06)
        ac.tap(key, 30)
        ac.send_key(self.burst_modifier, False)
        self.last_burst = time.time()
        time.sleep(0.55)

    def target_distance(self):
        state = self.auto_state or {}
        try:
            dist = float(state.get("lock_dist") or 0)
        except (TypeError, ValueError):
            dist = 0.0
        if dist <= 0:
            try:
                dist = float((state.get("nearest") or {}).get("dist") or 0)
            except (TypeError, ValueError):
                dist = 0.0
        return dist

    def skill_window(self):
        state = self.auto_state or {}
        if not state.get("locked"):
            return None
        ts = self.target_state()
        try:
            close_count = int(state.get("close_count") or 0)
            enemy_count = int(state.get("enemy_count") or 0)
        except (TypeError, ValueError):
            close_count, enemy_count = 0, 0
        return {
            "dist": self.target_distance(),
            "close": close_count,
            "count": enemy_count,
            "boss": bool(state.get("lock_boss")),
            "groggy": bool(ts.get("groggy")) or bool(ts.get("tired")),
            "running": bool(ts.get("running")),
        }

    def should_use_beta(self, role=None):
        win = self.skill_window()
        if not win:
            return False
        if self.beta_range > 0 and win["dist"] > self.beta_range:
            self.log('跳过贝塔：距离 %.0f > %.0f')
            return False
        return True

    def should_use_burst(self):
        if time.time() - self.last_burst < 12.0:
            return False
        win = self.skill_window()
        if not win:
            return False
        if self.burst_range > 0 and win["dist"] > self.burst_range:
            return False
        if win['dist']:
            # Bosses are the highest-value target.  The distance gate above
            # already prevents the old out-of-range waste.
            return True
        return win["groggy"] or win["close"] >= 2 \
            or win["count"] >= int(self.cfg.get("burst_min_enemies") or 3)

    def should_use_tachy(self):
        if time.time() - self.last_tachy < self.tachy_cooldown:
            return False
        win = self.skill_window()
        if not win:
            return False
        if self.tachy_range > 0 and win["dist"] > self.tachy_range:
            return False
        if win['dist']:
            # Tachy Mode is a boss-killer resource; do not skip a locked boss
            # merely because its stagger gauge is not broken yet.
            return True
        if win["running"] and not win["groggy"]:
            return False
        # Tachy Mode is a self-buff, not an AoE nuke.  The old ">=4 enemies"
        # rule meant a single elite never saw Tachy at all.  Range and
        # cooldown are the real safety gates; count still drives Beta/Burst.
        return True

    def use_tachy(self, reason=""):
        keys = [k for k in self.tachy_keys if k]
        if not keys:
            return False
        win = self.skill_window() or {}
        self.log("迅驰模式 %s（%s，距离 %.0f，怪 %d%s）" % (
            "+".join(k.upper() for k in keys),
            reason,
            win.get('+', 0),
            win.get("count", 0),
            "，Boss" if win.get("boss") else "",
        ))
        try:
            for k in keys:
                ac.send_key(k, True)
            time.sleep(0.15)
            for k in reversed(keys):
                ac.send_key(k, False)
        except Exception as exc:
            self.log('迅驰模式按键失败: %s')
            return False
        self.last_tachy = time.time()
        time.sleep(0.8)
        return True

    def try_relock(self):
        if not self.auto_relock or not self.was_locked:
            return False
        if time.time() - self.last_relock < self.auto_relock_cooldown:
            return False
        state = self.auto_state or {}
        if state.get("input_block") or state.get("paused"):
            return False
        try:
            enemy_count = int(state.get("enemy_count") or 0)
            mid_count = int(state.get("mid_count") or 0)
            nearest = float((state.get("nearest") or {}).get("dist") or 999999)
        except (TypeError, ValueError):
            enemy_count, mid_count, nearest = 0, 0, 999999
        if enemy_count <= 0 or (mid_count <= 0 and nearest > self.auto_relock_range):
            self.was_locked = False
            return False
        self.last_relock = time.time()
        self.log('自动索敌：锁定下一个目标')
        ac.tap(self.cfg["keys"].get("lock_on", "mouse_middle"), 40)
        time.sleep(0.25)
        return True

    def try_gap_close(self, dist):
        if not self.gap_close_enabled:
            return False
        if dist <= self.attack_range or dist > self.gap_close_max:
            return False
        if time.time() - self.last_gap_close < self.gap_close_cooldown:
            return False
        if self.gap_close_combo not in self.cfg["combos"]:
            return False
        self.last_gap_close = time.time()
        self.log('距离 %.0f，冲刺技能接敌')
        ac.run_combo(self.cfg, self.gap_close_combo, self.combo_state)
        time.sleep(0.2)
        return True

    def combo_worker(self):
        while not self.combo_state["stop"]:
            if self.emergency:
                self.set_forward(False)
                time.sleep(0.08)
                continue
            if not self.combo_on:
                self.set_forward(False)
                if self.combo_state["once"]:
                    if not ac.game_focused(self.cfg):
                        time.sleep(0.15)
                        continue
                    self.combo_state["once"] = False
                    self.log('执行单套：%s')
                    ac.run_combo(self.cfg, self.current_combo())
                    continue
                time.sleep(0.08)
                continue
            if not ac.game_focused(self.cfg):
                self.set_forward(False)
                time.sleep(0.15)
                continue

            if self.auto_engage:
                if not self.auto_state or time.time() - self.auto_state_at > 0.9:
                    self.set_forward(False)
                    time.sleep(0.12)
                    continue
                if self.auto_state.get("paused") or self.auto_state.get("move_ignored"):
                    self.set_forward(False)
                    time.sleep(0.15)
                    continue
                if self.auto_state.get("parried") and time.time() - self.last_counter > 1.2:
                    self.set_forward(False)
                    self.last_counter = time.time()
                    self.log('招架成功，自动反击')
                    ac.run_combo(self.cfg, "counter_ii", self.combo_state)
                    continue
                if not self.auto_state.get("locked") or not self.auto_state.get("lock_target"):
                    if self.try_relock():
                        continue
                    self.set_forward(False)
                    time.sleep(0.12)
                    continue
                if not self.was_locked:
                    self.was_locked = True
                    self.lock_entered_at = time.time()
                try:
                    dist = float(self.auto_state.get("lock_dist") or 0)
                except (TypeError, ValueError):
                    dist = 0.0
                if dist <= 0:
                    nearest = self.auto_state.get("nearest") or {}
                    try:
                        dist = float(nearest.get('nearest') or 999999)
                    except (TypeError, ValueError):
                        dist = 999999
                if dist > self.attack_range:
                    if self.try_gap_close(dist):
                        continue
                    self.set_forward(False)
                    time.sleep(0.12)
                    continue
                self.set_forward(False)

                if self.execution_window():
                    self.decision_role = "execute"
                    self.last_execution = time.time()
                    name = self.execution_combo if self.execution_combo in self.cfg["combos"] else "rush_chain"
                    if name not in self.cfg["combos"]:
                        name = "breaker_chain"
                    self.current_auto_combo = name
                    self.log('breaker_chain')
                    if self.run_auto_combo(name):
                        self.combo_state['破韧/处决窗口：%s'] += 1
                        if self.lock_entered_at:
                            self.log('cycle')
                            self.lock_entered_at = 0.0
                        if self.should_use_beta('接敌反应 %.2fs'):
                            self.use_beta("execute")
                        if self.should_use_burst():
                            self.use_burst('execute')
                    continue

                # A flow is a short arc of different strings, not one random
                # preset.  The next string starts while the previous recovery
                # is still finishing, which removes the "two tools running"
                # feeling from the old fixed-deck behaviour.
                plan = self.build_flow_plan()
                if not plan:
                    continue
                self.current_auto_combo = ' → '.join(plan)
                self.log('连段：%s')
                if self.run_flow_plan(plan):
                    self.combo_state['连段：%s'] += 1
                    if self.lock_entered_at:
                        self.log('cycle')
                        self.lock_entered_at = 0.0
                    if self.should_use_tachy():
                        win = self.skill_window() or {}
                        if win.get("groggy"):
                            tachy_reason = '破韧/疲劳'
                        elif win.get('groggy'):
                            tachy_reason = '破韧/疲劳'
                        elif win.get('boss', 0) >= 2:
                            tachy_reason = 'Boss近身'
                        else:
                            tachy_reason = '群怪'
                        self.use_tachy(tachy_reason)
                    used_beta = any(n.startswith('追击') for n in plan)
                    role = self.decision_role
                    if (not used_beta
                            and self.cfg.get("beta_after_combo", True)
                            and role in ("punish", "group", "break", "boss")
                            and time.time() - self.last_beta > 0.8
                            and self.should_use_beta(role)):
                        win = self.skill_window() or {}
                        beta_role = "aoe" if (role == "group" or win.get("count", 0) >= 2) else "burst"
                        self.use_beta(beta_role)
                        used_beta = True
                    beta_every = int(self.cfg.get("beta_every_cycles") or 0)
                    if (not used_beta and beta_every > 0
                            and self.combo_state['beta_every_cycles'] % beta_every == 0
                            and self.should_use_beta(role)):
                        win = self.skill_window() or {}
                        beta_role = "aoe" if (role == "group" or win.get("count", 0) >= 2) else "burst"
                        self.use_beta(beta_role)
                    if self.should_use_burst():
                        self.use_burst(role)
                continue

            name = self.choose_auto_combo()
            self.current_auto_combo = name
            self.log('连招：%s')
            ac.run_combo(self.cfg, name, self.combo_state)
            self.combo_state['连招：%s'] += 1
            beta_every = int(self.cfg.get("beta_every_cycles") or 0)
            if (beta_every > 0 and self.combo_state['cycle'] % beta_every == 0
                    and self.should_use_beta(self.decision_role)):
                self.use_beta(self.decision_role)
            if (self.burst_every > 0 and self.combo_state["cycle"] % self.burst_every == 0
                    and self.should_use_burst()):
                self.use_burst(self.decision_role)

    def potion_worker(self):
        while not self.combo_state["stop"]:
            if not self.auto_potion or self.emergency:
                time.sleep(0.3)
                continue
            snap = self.engine.snapshot()
            if not snap.get("hp_valid") or snap.get("max_hp", 0) <= 0:
                time.sleep(0.3)
                continue
            try:
                threshold = int(self.threshold)
            except (TypeError, ValueError):
                threshold = 35
            hp = int(snap["hp"])
            max_hp = int(snap["max_hp"])
            if hp <= 0:
                time.sleep(0.4)
                continue
            now = time.time()
            if self.last_hp is not None and hp < self.last_hp:
                lost_pct = (self.last_hp - hp) / max_hp * 100.0
                if lost_pct >= 8.0:
                    self.urgent_until = now + 3.0
            self.last_hp = hp
            if now < self.urgent_until:
                threshold = max(threshold, 50)
            ratio = hp / max_hp * 100.0
            if ratio < threshold and now - self.last_potion > 3.0 and ac.game_focused(self.cfg):
                ac.tap(self.cfg["keys"]["heal"], 50)
                self.last_potion = now
                self.log('自动喝药：HP %d/%d (%.0f%%)%s')
            time.sleep(0.4)

    def hotkey_worker(self):
        toggle_vk = ac.vk_of(self.cfg["toggle_key"])
        once_vk = ac.vk_of(self.cfg["once_key"])
        next_vk = ac.vk_of(self.cfg['toggle_key'])
        exit_vk = ac.vk_of(self.cfg['once_key'])
        emergency_vk = 0x76  # F7
        map_vk = 0x73  # F4
        capture_vk = 0x72  # F3
        game_hud_vk = 0x71  # F2
        drop_vk = 0x74  # F5
        ammo_vk = 0x75  # F6
        last = {"toggle": False, "once": False, "next": False, "exit": False, "emergency": False, "map": False, "capture": False, "gamehud": False, "drop": False, "ammo": False}
        while not self.combo_state["stop"]:
            if time.time() - self.started_at < 1.5:
                time.sleep(0.05)
                continue
            if ac.is_down(exit_vk):
                self.combo_state["stop"] = True
                return
            if ac.is_down(map_vk):
                if not last["map"]:
                    self.guide_map_requested = True
                last['map'] = True
            else:
                last['map'] = False
            if ac.is_down(capture_vk):
                if not last['map']:
                    self.capture_requested = True
                last['capture'] = True
            else:
                last['capture'] = False
            if ac.is_down(game_hud_vk):
                if not last['capture']:
                    self.game_hud_requested = True
                last['gamehud'] = True
            else:
                last['gamehud'] = False
            if ac.is_down(drop_vk):
                if not last['gamehud']:
                    self.toggle_drop()
                last['drop'] = True
            else:
                last['drop'] = False
            if ac.is_down(ammo_vk):
                if not last['drop']:
                    self.apply_ammo_patch()
                last['ammo'] = True
            else:
                last['ammo'] = False
            if ac.is_down(emergency_vk):
                if not last['ammo']:
                    self.emergency_stop()
                last['emergency'] = True
            else:
                last['emergency'] = False

            now = ac.is_down(toggle_vk)
            if now and not last["toggle"]:
                self.toggle_combo()
            last['toggle'] = now

            now = ac.is_down(once_vk)
            if now and not last["once"]:
                self.test_once()
            last['once'] = now

            now = ac.is_down(next_vk)
            if now and not last["next"]:
                self.advance_combo()
            last['next'] = now
            time.sleep(0.02)

    def vision_can_read(self):
        if self.vision_var is None or not self.vision_var.get():
            return False
        if not self.combo_on or not self.auto_state:
            return False
        if not self.auto_state.get("locked"):
            return False
        return time.time() - self.auto_state_at < 1.2

    def on_vision_toggle(self):
        enabled = bool(self.vision_var and self.vision_var.get())
        if enabled:
            self.vision_reader.start()
            self.log('视觉血条已开启（实验）：只在锁定时截取游戏窗口，不注入游戏')
        else:
            self.vision_reader.stop()
            self.log('视觉血条已关闭')
        return enabled

    # -------------------------------------------------------------- refresh
    def refresh(self):
        if self.combo_state["stop"]:
            try:
                self.engine.shutdown()
            except Exception:
                pass
            try:
                self.root.destroy()
            except Exception:
                pass
            return

        snap = self.engine.snapshot()
        if snap.get("connected"):
            self.game_var.set('游戏：已连接')
            binding = snap.get("binding")
            if binding == "features.ready":
                self.defense_var.set("防御：已开启")
            elif binding == "observation.ready":
                self.defense_var.set("防御：观察模式")
            else:
                self.defense_var.set("防御：连接中")
        else:
            self.game_var.set("游戏：等待角色")
            self.defense_var.set("防御：未连接")

        if snap.get("hp_valid"):
            self.hp_var.set("HP: %d / %d" % (snap.get("hp", 0), snap.get("max_hp", 0)))
        else:
            self.hp_var.set('HP: 等待读取')
        self._update_hp_bar(snap)
        self.game_label.config(fg="#4ade80" if snap.get("connected") else "#8194a8")
        self.defense_label.config(fg="#2ee6c5" if snap.get("binding") == "features.ready" else "#8194a8")
        self.counter_var.set(
            '格挡 %d/%d  闪避 %d  闪现 %d/%d'
            % (snap.get("guard_installed", 0), snap.get("guard_requests", 0),
               snap.get("installed", 0), snap.get("blue", 0), snap.get("purple", 0))
        )
        vision = self.vision_reader.snapshot()
        if vision.get("ratio") is not None:
            self.vision_text_var.set(
                "视觉血条: %d%%  置信 %d%%"
                % (round(vision["ratio"] * 100), round(vision.get("confidence", 0) * 100))
            )
        elif vision.get("error"):
            self.vision_text_var.set('视觉血条: %s' % vision["error"])
        else:
            self.vision_text_var.set('视觉血条: 未锁定/未检测到')

        if self.auto_state and time.time() - self.auto_state_at < 1.5:
            locked = bool(self.auto_state.get("locked"))
            target = self.auto_state.get("lock_target") or ""
            short_target = target.split(" ")[0] if target else ""
            if not locked:
                self.enemy_var.set('未锁定：手动对准/锁定怪物后自动战斗')
            elif self.auto_state.get('parried'):
                self.enemy_var.set('锁定: %s  招架成功，自动反击' % short_target)
            elif self.auto_state.get('running_skill'):
                self.enemy_var.set('锁定: %s  技能动作中' % short_target)
            elif self.auto_state.get('blocking'):
                self.enemy_var.set('锁定: %s  格挡中' % short_target)
            else:
                self.enemy_var.set(
                    '锁定: %s  距离: %.0f  自动战斗'
                    % (short_target, float(self.auto_state.get("lock_dist") or 0))
                )
        else:
            self.enemy_var.set('状态: --')

        if self.combo_box.get() != self.current_combo():
            self.combo_box.set(self.current_combo())
        self.start_btn.config(text="停止自动战斗 (F9)" if self.combo_on else "开始自动战斗 (F9)")

        if self.auto_state and time.time() - self.auto_state_at < 1.5 and self.auto_state.get("locked"):
            role_labels = {"defense": "低血防守", "boss": "Boss 破防", "group": "群怪横扫",
                           "danger": "敌人出招/保守", "gap": "中距突进", "single": "单体压制",
                           "punish": "破韧惩罚", "break": "破盾/破甲", "execute": "残血收割"}
            hp_text = ""
            try:
                snap = self.engine.snapshot()
                if snap.get("hp_valid") and int(snap.get("max_hp") or 0) > 0:
                    hp_text = " HP%d%%" % int(100 * float(snap.get("hp") or 0) / float(snap["max_hp"]))
            except Exception:
                pass
            ts = self.target_state()
            flags = []
            if ts.get("groggy"):
                flags.append("破韧")
            if ts.get("tired"):
                flags.append("疲劳")
            if ts.get("running"):
                flags.append("出招")
            state_text = (" " + "/".join(flags)) if flags else ""
            self.tactic_var.set("战术：%s | 连招：%s | 敌%d 近%d%s%s" % (
                role_labels.get(self.decision_role, self.decision_role),
                self.current_auto_combo,
                int(self.auto_state.get("enemy_count") or 0),
                int(self.auto_state.get("close_count") or 0),
                hp_text,
                state_text,
            ))
        elif self.auto_state and self.auto_state.get("reason") == "no-player":
            self.tactic_var.set('战术：角色未加载（菜单/加载中）')
        else:
            self.tactic_var.set('战术：等待锁定')

        if self.auto_state and time.time() - self.auto_state_at < 1.5:
            force = bool(self.auto_state.get("drop_force"))
            err = self.auto_state.get("drop_error") or ""
            self.drop_var.set("最高掉宝率：%s%s" % ("开" if force else "关", ("  " + err) if err else ""))
        else:
            self.drop_var.set("最高掉宝率：未知")

        if self.map_toggle_requested:
            self.map_toggle_requested = False
            self.set_map_visible(self.map_window is None)
        if self.guide_map_requested:
            self.guide_map_requested = False
            self.open_guide_map()
        if self.capture_requested:
            self.capture_requested = False
            self.capture_game_map()
        if self.game_hud_requested:
            self.game_hud_requested = False
            self.toggle_game_hud()
        if self.game_hud is not None:
            self.game_hud.update()
        if self.map_window is not None:
            self.draw_map()

        while True:
            try:
                line = self.log_queue.get_nowait()
            except queue.Empty:
                break
            self.log_text.configure(state="normal")
            low = line.lower()
            if ("失败" in line) or ("错误" in line) or ("异常" in line) or ("error" in low):
                tag = 'normal'
            elif ("已开启" in line) or ("已加载" in line) or ("开始自动战斗" in line) or ("连招：" in line):
                tag = "ok"
            elif ("等待" in line) or ("未锁定" in line) or ("急停" in line):
                tag = "warn"
            else:
                tag = "info"
            self.log_text.insert("end", line + "\n", tag)
            self.log_text.see("end")
            self.log_text.configure(state='disabled')

        self.root.after(120, self.refresh)


def main():
    if frida is None:
        messagebox.showerror("缺少依赖", "未找到 frida 模块，无法启动防御引擎")
        return

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    mutex = kernel32.CreateMutexW(None, False, MUTEX_NAME)
    if mutex and ctypes.get_last_error() == 183:
        root = tk.Tk()
        root.withdraw()
        messagebox.showerror("已在运行", "SB Combat Assistant 已经有一个实例在运行。")
        root.destroy()
        return

    root = tk.Tk()
    app = App(root)
    root.mainloop()
    try:
        app.engine.shutdown()
    except Exception:
        pass


if __name__ == "__main__":
    main()

