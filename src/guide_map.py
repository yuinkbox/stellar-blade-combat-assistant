import ctypes
import glob
import http.server
import json
import os
import socketserver
import subprocess
import threading
import time
import urllib.request
from urllib.parse import urlparse, parse_qs

GAME_STATE = r"E:\Steam\steamapps\common\StellarBlade\SB\Binaries\Win64\ue4ss\Mods\SBAutoBattleState\state.json"
CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def _read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except Exception:
        return default


def _solve_affine(pairs):
    if len(pairs) < 3:
        return None
    p = pairs[:3]
    x1, y1 = p[0]["world"][:2]
    x2, y2 = p[1]["world"][:2]
    x3, y3 = p[2]["world"][:2]
    mx1, my1 = p[0]["map"][:2]
    mx2, my2 = p[1]["map"][:2]
    mx3, my3 = p[2]["map"][:2]
    den = (x1 - x2) * (y1 - y3) - (x1 - x3) * (y1 - y2)
    if abs(den) < 1e-9:
        return None
    a = ((mx1 - mx2) * (y1 - y3) - (mx1 - mx3) * (y1 - y2)) / den
    b = ((x1 - x2) * (mx1 - mx3) - (x1 - x3) * (mx1 - mx2)) / den
    c = mx1 - a * x1 - b * y1
    d = ((my1 - my2) * (y1 - y3) - (my1 - my3) * (y1 - y2)) / den
    e = ((x1 - x2) * (my1 - my3) - (x1 - x3) * (my1 - my2)) / den
    f = my1 - d * x1 - e * y1
    return a, b, c, d, e, f


class _Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        server = args[2] if len(args) >= 3 else kwargs.get("server")
        super().__init__(*args, directory=server.map_dir, **kwargs)

    def send_json(self, obj):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        srv = self.server
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/regions":
            regions = []
            for mid, data in sorted(srv.maps.items()):
                info = data.get("map") or {}
                raw = info.get("name") or ("地图 %d" % mid)
                name = raw.replace("剑星_游戏地图-", "").replace("剑星_", "")
                regions.append({"id": mid, "name": name,
                                "landmarks": len(data.get("landmarks") or [])})
            self.send_json({"ok": True, "regions": regions})
            return

        if path.startswith("/api/map/"):
            try:
                mid = int(path.rsplit("/", 1)[1])
                self.send_json(srv.maps.get(mid))
            except Exception:
                self.send_response(404)
                self.end_headers()
            return

        if path == "/api/state":
            self.send_json(_read_json(GAME_STATE, {}) or {})
            return

        if path == "/api/player":
            q = parse_qs(parsed.query)
            try:
                mid = int((q.get("map") or ["97"])[0])
            except ValueError:
                mid = 97
            state = _read_json(GAME_STATE, {}) or {}
            player = state.get("player") or [0, 0, 0]
            pairs = (_read_json(srv.calibration_path, {}) or {}).get(str(mid)) or []
            tr = _solve_affine(pairs)
            if not tr or len(player) < 2:
                self.send_json({"ok": False, "reason": "need-calibration", "points": len(pairs)})
                return
            a, b, c, d, e, f = tr
            x, y = float(player[0]), float(player[1])
            self.send_json({"ok": True, "x": a * x + b * y + c, "y": d * x + e * y + f,
                            "yaw": state.get("yaw", 0), "points": len(pairs)})
            return

        if path == "/api/clear":
            q = parse_qs(parsed.query)
            try:
                mid = int((q.get("map") or ["97"])[0])
            except ValueError:
                mid = 97
            calib = _read_json(srv.calibration_path, {}) or {}
            calib.pop(str(mid), None)
            with open(srv.calibration_path, "w", encoding="utf-8") as f:
                json.dump(calib, f, ensure_ascii=False, indent=2)
            self.send_json({"ok": True})
            return

        if path == "/api/calibrate":
            q = parse_qs(parsed.query)
            try:
                mid = int((q.get("map") or ["97"])[0])
                lid = int((q.get("id") or ["0"])[0])
            except ValueError:
                self.send_json({"ok": False, "error": "bad-args"})
                return
            state = _read_json(GAME_STATE, {}) or {}
            player = state.get("player") or []
            data = srv.maps.get(mid) or {}
            landmark = None
            for l in data.get("landmarks") or []:
                if int(l.get("id", -1)) == lid:
                    landmark = l
                    break
            if not player or landmark is None:
                self.send_json({"ok": False, "error": "no-player-or-landmark"})
                return
            calib = _read_json(srv.calibration_path, {}) or {}
            key = str(mid)
            pairs = [p for p in (calib.get(key) or []) if int(p.get("id", -1)) != lid]
            pairs.append({
                "id": lid,
                "name": landmark.get("name") or "",
                "world": [float(player[0]), float(player[1]), float(player[2])],
                "map": [float(landmark.get("x", 0)), float(landmark.get("y", 0))],
            })
            calib[key] = pairs
            with open(srv.calibration_path, "w", encoding="utf-8") as f:
                json.dump(calib, f, ensure_ascii=False, indent=2)
            self.send_json({"ok": True, "points": len(pairs), "name": landmark.get("name") or ""})
            return

        if path.startswith("/tiles/"):
            rest = path[len("/tiles/"):]
            parts = rest.split("/")
            if len(parts) == 3:
                mid_s, z, xy = parts
                try:
                    mid = int(mid_s)
                except ValueError:
                    mid = 97
                data = srv.maps.get(mid) or {}
                root = ((data.get("map") or {}).get("mapTileUrlsRoot") or "").split("/{z}")[0]
                cache_dir = os.path.join(srv.cache_dir, str(mid))
                os.makedirs(cache_dir, exist_ok=True)
                fname = os.path.join(cache_dir, z + "_" + xy)
                if not os.path.isfile(fname):
                    url = "%s/%s/%s" % (root, z, xy)
                    try:
                        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
                        with urllib.request.urlopen(req, timeout=20) as r:
                            blob = r.read()
                        with open(fname, "wb") as f:
                            f.write(blob)
                    except Exception:
                        self.send_response(404)
                        self.end_headers()
                        return
                with open(fname, "rb") as f:
                    blob = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(blob)))
                self.end_headers()
                self.wfile.write(blob)
                return

        super().do_GET()

    def log_message(self, fmt, *args):
        pass


class MapServer:
    def __init__(self, map_dir, log):
        self.map_dir = map_dir
        self.log = log
        self.maps = {}
        for path in sorted(glob.glob(os.path.join(map_dir, "data", "map_*.json"))):
            try:
                mid = int(os.path.basename(path).split("_")[1].split(".")[0])
            except Exception:
                continue
            self.maps[mid] = _read_json(path, {})
        self.calibration_path = os.path.join(map_dir, "data", "calibration.json")
        self.cache_dir = os.path.join(map_dir, "tile_cache")
        os.makedirs(self.cache_dir, exist_ok=True)
        self.httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), _Handler)
        self.httpd.map_dir = map_dir
        self.httpd.maps = self.maps
        self.httpd.calibration_path = self.calibration_path
        self.httpd.cache_dir = self.cache_dir
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.log("攻略地图服务已启动: http://127.0.0.1:%d/map.html" % self.port)

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass

    def url(self, map_id=97, hud=False):
        return "http://127.0.0.1:%d/map.html?map=%d%s" % (self.port, map_id, "&hud=1" if hud else "")

    def open_map(self, map_id=97, hud=False):
        url = self.url(map_id, hud=hud)
        chrome = next((p for p in CHROME_CANDIDATES if os.path.isfile(p)), None)
        if not chrome:
            import webbrowser
            webbrowser.open(url)
            return None
        user32 = ctypes.windll.user32
        screen_w = user32.GetSystemMetrics(0)
        screen_h = user32.GetSystemMetrics(1)
        if hud:
            width, height = 760, 560
        else:
            width, height = 1280, 900
        x = max(0, screen_w - width - 20)
        y = max(0, min(70, screen_h - height - 70))
        proc = subprocess.Popen([chrome, "--app=" + url,
                                 "--window-size=%d,%d" % (width, height),
                                 "--window-position=%d,%d" % (x, y)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

        # Small always-on-top HUD, or a large guide window.
        def topmost():
            hwnd = 0
            for _ in range(24):
                time.sleep(0.5)
                hwnd = user32.FindWindowW(None, "SB Guide Map")
                if hwnd:
                    break
            if not hwnd:
                return
            for _ in range(4):
                if hud:
                    GWL_STYLE = -16
                    GWL_EXSTYLE = -20
                    WS_CAPTION = 0x00C00000
                    WS_THICKFRAME = 0x00040000
                    WS_EX_LAYERED = 0x00080000
                    style = user32.GetWindowLongW(hwnd, GWL_STYLE)
                    user32.SetWindowLongW(hwnd, GWL_STYLE, style & ~WS_CAPTION & ~WS_THICKFRAME)
                    ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
                    user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED)
                    user32.SetLayeredWindowAttributes(hwnd, 0, 238, 0x00000002)
                user32.SetWindowPos(hwnd, -1, x, y, width, height, 0x0040)
                time.sleep(0.3)
        threading.Thread(target=topmost, daemon=True).start()
        return proc

