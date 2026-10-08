import os
import time
import asyncio
from pathlib import Path

import psutil
import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.types import Scope

# --- host /proc + /sys redirect (container runs with pid:host, host /proc and /sys bind-mounted) ---
HOST_PROC = os.environ.get("HOST_PROC", "/proc")
HOST_SYS = os.environ.get("HOST_SYS", "/sys")
if Path(HOST_PROC).exists() and HOST_PROC != "/proc":
    psutil.PROCFS_PATH = HOST_PROC

NET_IFACE = os.environ.get("NET_IFACE", "eth0")
WG_URL = os.environ.get("WG_EASY_URL", "http://127.0.0.1:51821").rstrip("/")
WG_PASSWORD = os.environ.get("WG_EASY_PASSWORD", "")

app = FastAPI()

# ---------------- system stats ----------------
# Container runs on a normal bridge network (no network_mode:host, no
# pid:host needed): /proc/stat and /proc/meminfo are not net/pid-namespaced
# in plain Docker, so the container's own /proc already reflects the host.
# Network counters ARE per-netns though, so those are read straight from the
# host's bind-mounted /sys/class/net/<iface>/statistics instead of psutil,
# which would otherwise only see the container's own veth.

_last_net = None  # (timestamp, rx_bytes, tx_bytes)


def _read_int(path: Path) -> int | None:
    try:
        return int(path.read_text().strip())
    except Exception:
        return None


def read_temp_c() -> float | None:
    # try common thermal zones, pick the highest plausible CPU reading
    base = Path(HOST_SYS) / "class" / "thermal"
    best = None
    if base.exists():
        for zone in base.glob("thermal_zone*"):
            try:
                t = int((zone / "temp").read_text().strip()) / 1000.0
                if 0 < t < 150:
                    if best is None or t > best:
                        best = t
            except Exception:
                continue
    return best


def net_rates():
    global _last_net
    net_class = Path(HOST_SYS) / "class" / "net"

    iface = NET_IFACE if (net_class / NET_IFACE).exists() else None
    if iface is None and net_class.exists():
        # fall back to first non-loopback interface with real stats
        for cand in sorted(net_class.iterdir()):
            if cand.name != "lo" and (cand / "statistics" / "rx_bytes").exists():
                iface = cand.name
                break
    if iface is None:
        return {"iface": None, "rx_bps": 0, "tx_bps": 0}

    stats = net_class / iface / "statistics"
    rx = _read_int(stats / "rx_bytes")
    tx = _read_int(stats / "tx_bytes")
    now = time.time()

    rx_bps = tx_bps = 0.0
    if rx is not None and tx is not None and _last_net is not None:
        last_t, last_rx, last_tx = _last_net
        dt = max(now - last_t, 0.001)
        rx_bps = max((rx - last_rx) / dt, 0)
        tx_bps = max((tx - last_tx) / dt, 0)
    if rx is not None and tx is not None:
        _last_net = (now, rx, tx)
    return {"iface": iface, "rx_bps": rx_bps, "tx_bps": tx_bps}


@app.get("/api/system")
def system_stats():
    cpu = psutil.cpu_percent(interval=0.3)
    vm = psutil.virtual_memory()
    net = net_rates()
    return {
        "cpu_pct": cpu,
        "mem_used_gb": round(vm.used / 1024**3, 2),
        "mem_total_gb": round(vm.total / 1024**3, 2),
        "mem_pct": vm.percent,
        "temp_c": read_temp_c(),
        "net": net,
        "ts": time.time(),
    }


# ---------------- wg-easy proxy ----------------

_wg_cookie: str | None = None
_wg_lock = asyncio.Lock()


async def wg_login() -> str | None:
    # Fresh client, used only for this one request: reusing a client that
    # already made an earlier (unauthenticated/failed) request carries that
    # request's cookie jar along, and wg-easy's session middleware chokes on
    # the stale/duplicate cookie, breaking the login call itself.
    global _wg_cookie
    async with httpx.AsyncClient(timeout=5) as client:
        r = await client.post(f"{WG_URL}/api/session", json={"password": WG_PASSWORD})
        if r.status_code // 100 == 2:
            cookie = r.cookies.get("connect.sid")
            if cookie:
                _wg_cookie = cookie
                return cookie
    return None


async def wg_fetch_clients(cookie: str) -> httpx.Response:
    async with httpx.AsyncClient(timeout=5) as client:
        return await client.get(
            f"{WG_URL}/api/wireguard/client", cookies={"connect.sid": cookie}
        )


async def wg_get_clients():
    global _wg_cookie
    async with _wg_lock:
        r = await wg_fetch_clients(_wg_cookie) if _wg_cookie else None
        # This wg-easy version returns 500 (not 401/403) for an
        # unauthenticated/expired-session request, so any non-2xx (or no
        # cached cookie at all) is treated as "need to (re)login".
        if r is None or r.status_code // 100 != 2:
            cookie = await wg_login()
            if not cookie:
                return None, "auth_failed"
            r = await wg_fetch_clients(cookie)
        if r.status_code // 100 != 2:
            return None, f"http_{r.status_code}"
        try:
            return r.json(), None
        except Exception:
            return None, "bad_json"


@app.get("/api/wg")
async def wg_clients():
    data, err = await wg_get_clients()
    if err:
        return JSONResponse({"error": err}, status_code=502)
    clients = []
    for c in data:
        clients.append(
            {
                "name": c.get("name"),
                "enabled": c.get("enabled"),
                "address": c.get("address"),
                "rx": c.get("transferRx", 0),
                "tx": c.get("transferTx", 0),
                "last_handshake": c.get("latestHandshakeAt"),
            }
        )
    online = sum(1 for c in clients if c["last_handshake"] and _is_recent(c["last_handshake"]))
    return {"clients": clients, "total": len(clients), "online": online}


def _is_recent(iso_ts: str, window_sec: int = 150) -> bool:
    try:
        from datetime import datetime, timezone

        t = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - t).total_seconds() < window_sec
    except Exception:
        return False


# ---------------- static frontend ----------------
# No default Cache-Control -> browsers use heuristic caching and can keep
# serving a stale index.html/app.js for a long time after a deploy, with no
# way to tell without a hard refresh. Force revalidation on every request.


class NoCacheStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
        return response


static_dir = Path(__file__).parent / "static"
app.mount("/", NoCacheStaticFiles(directory=str(static_dir), html=True), name="static")
