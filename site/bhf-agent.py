#!/usr/bin/env python3
"""bhf-agent – keeps an Arduino Uno on the firmware published for it on bhf.pp.ua.

Runs on the computer the board is plugged into (Windows, macOS, Ubuntu/Debian, Raspberry Pi OS).
Python 3.8+ standard library only; avrdude must be installed. pyserial is optional
(used to read the board's Serial output after flashing; without it Linux/macOS still work, Windows skips the check).

  python3 bhf-agent.py setup --device ID --token TOKEN [--port PORT]   # once: save the config
  python3 bhf-agent.py once                                            # check + flash if a new version is published
  python3 bhf-agent.py run                                             # the same every 60 s (service mode)
  python3 bhf-agent.py status                                          # what the server has, what is on the board
  python3 bhf-agent.py flash firmware.zip [--port PORT]                # manual flash of a downloaded zip or .hex
  python3 bhf-agent.py ports                                           # serial ports found

Help: https://bhf.pp.ua/help/
"""
import argparse
import glob
import hashlib
import io
import json
import logging
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

VERSION = "1.0"
SERVER = "https://bhf.pp.ua"
BAUD = 115200
MAX_TRIES = 3            # failed flashes of the same version before the agent waits for a newer one
WIN = os.name == "nt"
log = logging.getLogger("bhf-agent")


# ---------------------------------------------------------------- config / state
def default_config():
    if WIN:
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "bhf-agent", "config.json")
    return os.path.join(os.path.expanduser("~"), ".config", "bhf-agent", "config.json")


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, data, private=False):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    if private and not WIN:
        os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def state_path(cfg_path):
    return os.path.join(os.path.dirname(os.path.abspath(cfg_path)), "state.json")


# ---------------------------------------------------------------- server
def api(cfg, method, path, body=None, raw=False):
    url = cfg.get("server", SERVER).rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        "Authorization": "Bearer " + cfg["token"], "User-Agent": "bhf-agent/" + VERSION,
        **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            out = r.read()
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", "")
        except ValueError:
            msg = ""
        raise RuntimeError(f"{method} {path}: HTTP {e.code} {msg}".strip())
    except urllib.error.URLError as e:
        hint = " (macOS python.org Python: run 'Install Certificates.command' or use Homebrew python)" \
            if "CERTIFICATE" in str(e.reason).upper() else ""
        raise RuntimeError(f"{method} {path}: {e.reason}{hint}")
    return out if raw else json.loads(out or b"{}")


def report(cfg, **kw):
    try:
        api(cfg, "POST", f"/api/devices/{cfg['device']}/report",
            {**kw, "host": socket.gethostname()[:60], "os": f"{platform.system()} {platform.machine()}"})
    except Exception as e:  # noqa: BLE001 – a failed report must not stop the agent
        log.warning("report failed: %s", e)


# ---------------------------------------------------------------- serial ports / avrdude
def find_ports():
    if WIN:
        try:
            import winreg
            k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r"HARDWARE\DEVICEMAP\SERIALCOMM")
            out, i = [], 0
            while True:
                try:
                    out.append(winreg.EnumValue(k, i)[1])
                    i += 1
                except OSError:
                    break
            return sorted(out)
        except OSError:
            return []
    if sys.platform == "darwin":
        pats = ["/dev/cu.usbmodem*", "/dev/cu.usbserial*", "/dev/cu.wchusbserial*"]
    else:   # Linux / Raspberry Pi (ttyAMA*/ttyS* are the Pi's own UARTs, not USB boards)
        pats = ["/dev/ttyACM*", "/dev/ttyUSB*"]
    return sorted(p for pat in pats for p in glob.glob(pat))


def pick_port(cfg):
    if cfg.get("port"):
        return cfg["port"]
    ports = find_ports()
    if not ports:
        raise RuntimeError("no serial port found – is the board plugged in? (python3 bhf-agent.py ports)")
    if len(ports) > 1:
        log.info("several ports %s, using %s (set one: setup --port ...)", ports, ports[0])
    return ports[0]


def find_avrdude(cfg):
    here = os.path.dirname(os.path.abspath(__file__))
    for c in [cfg.get("avrdude"), shutil.which("avrdude"),
              os.path.join(here, "avrdude", "avrdude.exe"), os.path.join(here, "avrdude.exe"),
              "/opt/homebrew/bin/avrdude", "/usr/local/bin/avrdude", "/usr/bin/avrdude"]:
        if c and os.path.isfile(c):
            return c
    raise RuntimeError("avrdude not found – install it (see https://bhf.pp.ua/help/) or setup --avrdude PATH")


def flash_hex(cfg, hexfile, port):
    avr = find_avrdude(cfg)
    bauds = [cfg.get("upload_baud")] if cfg.get("upload_baud") else [115200, 57600]   # 57600 = old bootloaders
    out = ""
    for b in bauds:
        cmd = [avr, "-c", "arduino", "-p", "m328p", "-P", port, "-b", str(b), "-U", f"flash:w:{hexfile}:i"]
        log.info("flashing: %s", " ".join(cmd))
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
        except subprocess.TimeoutExpired:
            out = "avrdude timeout"
            continue
        out = (p.stdout + p.stderr).strip()
        if p.returncode == 0:
            return True, b, out
        log.warning("avrdude at %s baud failed: %s", b, out.splitlines()[-1] if out else p.returncode)
    return False, None, out


def read_serial(port, seconds=6.0):
    """Board output for a few seconds after opening the port (opening resets the Uno). None = not possible here."""
    try:
        import serial  # pyserial, optional
        with serial.Serial(port, BAUD, timeout=0.3) as s:
            buf, end = b"", time.time() + seconds
            while time.time() < end:
                buf += s.read(512)
            return buf.decode("utf-8", "replace")
    except ImportError:
        pass
    except Exception as e:  # noqa: BLE001
        return f"(serial: {e})"
    if WIN:
        return None
    import termios
    try:
        fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    except OSError as e:
        return f"(serial: {e})"
    try:
        a = termios.tcgetattr(fd)
        a[0] = a[1] = a[3] = 0                                     # raw: no input/output/local processing
        a[2] = termios.CS8 | termios.CREAD | termios.CLOCAL
        a[4] = a[5] = termios.B115200
        termios.tcsetattr(fd, termios.TCSANOW, a)
        buf, end = b"", time.time() + seconds
        while time.time() < end:
            try:
                buf += os.read(fd, 512)
            except BlockingIOError:
                time.sleep(0.1)
        return buf.decode("utf-8", "replace")
    finally:
        os.close(fd)


def hex_from(data, name):
    """.hex bytes from a downloaded zip (or a plain .hex)."""
    if data[:2] == b"PK":
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if n.lower().endswith(".hex")]
            if not names:
                raise RuntimeError(f"no .hex in {name}")
            return names[0], z.read(names[0])
    if data[:1] == b":":
        return name, data
    raise RuntimeError(f"{name} is neither a zip nor an Intel hex file")


def flash_bytes(cfg, data, name, job=None):
    """Write the .hex to a temp file, flash, read Serial. -> dict for the report."""
    hexname, hexdata = hex_from(data, name)
    port = pick_port(cfg)
    with tempfile.TemporaryDirectory(prefix="bhf-") as d:
        path = os.path.join(d, os.path.basename(hexname))
        with open(path, "wb") as f:
            f.write(hexdata)
        ok, baud, out = flash_hex(cfg, path, port)
    if not ok:
        return {"ok": False, "verified": None, "message": (out.splitlines() or ["avrdude failed"])[-1][:300], "serial": ""}
    time.sleep(0.5)
    ser = read_serial(port)
    verified = None
    if ser is not None and job:
        verified = f"job {job}" in ser
    log.info("flashed %s on %s at %s baud; serial: %s", hexname, port, baud,
             (ser or "(not read – pip install pyserial)").strip().splitlines()[:3])
    return {"ok": True, "verified": verified, "message": f"{hexname} on {port}, {baud} baud", "serial": (ser or "")[:1000]}


# ---------------------------------------------------------------- commands
def check(cfg, cfg_path):
    st_path = state_path(cfg_path)
    st = load(st_path, {}) or {}
    info = api(cfg, "GET", f"/api/devices/{cfg['device']}?agent=1")
    cur = info.get("current")
    if not cur:
        log.info("nothing published for %s yet", cfg["device"])
        return
    if cur["sha256"] == st.get("sha256"):
        log.debug("up to date: version %s", cur["version"])
        return
    tries = st.get("tries", {}).get(cur["sha256"], 0)
    if tries >= MAX_TRIES:
        log.debug("version %s failed %d times, waiting for a newer one", cur["version"], tries)
        return
    log.info("new version %s (job %s, %s) – downloading", cur["version"], cur["job"], cur["filename"])
    data = api(cfg, "GET", cur["url"], raw=True)
    if hashlib.sha256(data).hexdigest() != cur["sha256"]:
        raise RuntimeError("sha256 mismatch – download corrupted, will retry")
    try:
        r = flash_bytes(cfg, data, cur["filename"], cur["job"])
    except RuntimeError as e:
        r = {"ok": False, "verified": None, "message": str(e)[:300], "serial": ""}
    if r["ok"]:
        st = {"sha256": cur["sha256"], "version": cur["version"], "job": cur["job"], "filename": cur["filename"],
              "flashed": time.strftime("%Y-%m-%d %H:%M:%S"), "tries": {}}
        log.info("version %s flashed%s", cur["version"],
                 {True: ", firmware confirmed on Serial", False: ", but Serial did not show the job id", None: ""}[r["verified"]])
    else:
        st.setdefault("tries", {})[cur["sha256"]] = tries + 1
        log.error("flash failed (%d/%d): %s", tries + 1, MAX_TRIES, r["message"])
    save(st_path, st)
    report(cfg, version=cur["version"], job=cur["job"], **r)


def need(cfg):
    if not cfg or not cfg.get("device") or not cfg.get("token"):
        sys.exit("not configured – run: python3 bhf-agent.py setup --device ID --token TOKEN")
    return cfg


def main():
    ap = argparse.ArgumentParser(description="bhf.pp.ua firmware auto-update agent", epilog="https://bhf.pp.ua/help/")
    ap.add_argument("--config", default=default_config(), help="config file (default: %(default)s)")
    ap.add_argument("--log", help="also write the log to this file")
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("setup", help="save device id, token and options")
    s.add_argument("--device", required=True)
    s.add_argument("--token", required=True)
    s.add_argument("--port", help="serial port, e.g. COM3, /dev/ttyACM0 (default: auto)")
    s.add_argument("--avrdude", help="path to avrdude (default: PATH / next to this script)")
    s.add_argument("--interval", type=int, default=60, help="seconds between checks (min 30)")
    s.add_argument("--server", default=SERVER)
    sub.add_parser("once", help="check once, flash if a new version is published")
    sub.add_parser("run", help="check every --interval seconds (service mode)")
    sub.add_parser("status", help="server state and what this agent flashed last")
    f = sub.add_parser("flash", help="manual flash of a zip / .hex file")
    f.add_argument("file")
    f.add_argument("--port")
    sub.add_parser("ports", help="list serial ports")
    a = ap.parse_args()

    handlers = [logging.StreamHandler(sys.stdout)] if sys.stdout else []
    if a.log:
        handlers.append(logging.FileHandler(a.log, encoding="utf-8"))
    logging.basicConfig(level=logging.DEBUG if a.verbose else logging.INFO, handlers=handlers or [logging.NullHandler()],
                        format="%(asctime)s %(levelname)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S")
    cfg = load(a.config, {}) or {}

    if a.cmd == "ports":
        print("\n".join(find_ports()) or "no serial ports found")
    elif a.cmd == "setup":
        cfg = {"server": a.server.rstrip("/"), "device": a.device.strip(), "token": a.token.strip(),
               "port": a.port or "", "avrdude": a.avrdude or "", "interval": max(30, a.interval)}
        info = api(cfg, "GET", f"/api/devices/{cfg['device']}")          # checks id + token
        save(a.config, cfg, private=True)
        print(f"saved {a.config} – device {info['id']} {info.get('name') or ''} ({info['board_name']})")
        try:
            print("avrdude:", find_avrdude(cfg))
        except RuntimeError as e:
            print("WARNING:", e)
        print("ports:", ", ".join(find_ports()) or "none found (plug the board in)")
    elif a.cmd == "status":
        cfg = need(cfg)
        info = api(cfg, "GET", f"/api/devices/{cfg['device']}")
        st = load(state_path(a.config), {}) or {}
        print(json.dumps({"server": info, "this_agent": st}, indent=2, ensure_ascii=False))
    elif a.cmd == "flash":
        if a.port:
            cfg["port"] = a.port
        with open(a.file, "rb") as fh:
            data = fh.read()
        r = flash_bytes(cfg, data, os.path.basename(a.file))
        print(r["message"])
        if r["serial"]:
            print("--- serial ---\n" + r["serial"].strip())
        sys.exit(0 if r["ok"] else 1)
    elif a.cmd == "once":
        check(need(cfg), a.config)
    elif a.cmd == "run":
        cfg = need(cfg)
        log.info("bhf-agent %s: device %s, every %ss", VERSION, cfg["device"], cfg.get("interval", 60))
        while True:
            try:
                check(cfg, a.config)
            except Exception as e:  # noqa: BLE001 – keep running (network down, board unplugged, …)
                log.error("%s", e)
            time.sleep(max(30, int(cfg.get("interval", 60))))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except RuntimeError as e:
        sys.exit(f"error: {e}")
