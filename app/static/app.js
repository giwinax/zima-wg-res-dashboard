const POLL_MS = 2000;

const cpuHistory = [];
const netHistory = [];
const HIST_LEN = 60;

function fmtBytes(n) {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(1) + " " + units[i];
}

function fmtRate(bps) {
  return fmtBytes(bps) + "/s";
}

function fmtAgo(iso) {
  if (!iso) return "никогда";
  const sec = (Date.now() - new Date(iso).getTime()) / 1000;
  if (sec < 60) return Math.floor(sec) + "с назад";
  if (sec < 3600) return Math.floor(sec / 60) + "м назад";
  if (sec < 86400) return Math.floor(sec / 3600) + "ч назад";
  return Math.floor(sec / 86400) + "д назад";
}

function setBar(el, pct) {
  const bar = el.querySelector("div");
  bar.style.width = Math.min(100, Math.max(0, pct)) + "%";
  el.classList.remove("warn", "bad");
  if (pct >= 90) el.classList.add("bad");
  else if (pct >= 70) el.classList.add("warn");
}

function drawSparkline(canvas, values, color) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  const max = Math.max(...values, 1);
  const min = 0;
  const step = w / (HIST_LEN - 1);
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = w - (values.length - 1 - i) * step;
    const y = h - ((v - min) / (max - min || 1)) * h;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.lineTo(w, h);
  ctx.lineTo(w - (values.length - 1) * step, h);
  ctx.closePath();
  ctx.fillStyle = color + "22";
  ctx.fill();
}

async function pollSystem() {
  try {
    const r = await fetch("/api/system");
    const d = await r.json();
    document.getElementById("conn-dot").classList.remove("off");

    document.getElementById("cpu-val").textContent = d.cpu_pct.toFixed(0) + "%";
    setBar(document.getElementById("cpu-bar"), d.cpu_pct);
    cpuHistory.push(d.cpu_pct);
    if (cpuHistory.length > HIST_LEN) cpuHistory.shift();
    drawSparkline(document.getElementById("cpu-chart"), cpuHistory, "#4fd1c5");

    document.getElementById("mem-val").textContent = d.mem_pct.toFixed(0) + "%";
    document.getElementById("mem-sub").textContent =
      d.mem_used_gb.toFixed(1) + " / " + d.mem_total_gb.toFixed(1) + " GB";
    setBar(document.getElementById("mem-bar"), d.mem_pct);

    document.getElementById("temp-val").textContent =
      d.temp_c != null ? d.temp_c.toFixed(1) + "°C" : "н/д";

    const netTotal = d.net.rx_bps + d.net.tx_bps;
    netHistory.push(netTotal);
    if (netHistory.length > HIST_LEN) netHistory.shift();
    document.getElementById("net-iface").textContent = d.net.iface || "—";
    document.getElementById("net-val").textContent =
      "↓ " + fmtRate(d.net.rx_bps) + "  ↑ " + fmtRate(d.net.tx_bps);
    drawSparkline(document.getElementById("net-chart"), netHistory, "#4fd1c5");

    document.getElementById("last-update").textContent =
      "обновлено " + new Date().toLocaleTimeString("ru-RU");
  } catch (e) {
    document.getElementById("conn-dot").classList.add("off");
  }
}

let statusSortDir = -1; // -1: online сверху (по умолчанию), 1: offline сверху

async function pollWg() {
  try {
    const r = await fetch("/api/wg");
    if (!r.ok) throw new Error("bad status");
    const d = await r.json();
    document.getElementById("wg-val").textContent = d.online + " / " + d.total;

    const tbody = document.getElementById("wg-table");
    if (!d.clients.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="mono">нет клиентов</td></tr>';
      return;
    }
    const withStatus = d.clients.map(c => {
      const online = c.enabled && c.last_handshake &&
        (Date.now() - new Date(c.last_handshake).getTime()) / 1000 < 150;
      return { ...c, online };
    });
    withStatus.sort((a, b) => {
      if (a.online !== b.online) return a.online ? statusSortDir : -statusSortDir;
      return a.name.localeCompare(b.name);
    });
    tbody.innerHTML = withStatus.map(c => `<tr>
        <td>${c.name}</td>
        <td><span class="badge ${c.online ? "online" : "offline"}">${c.online ? "online" : "offline"}</span></td>
        <td class="mono">${c.address || "—"}</td>
        <td class="mono">${fmtAgo(c.last_handshake)}</td>
        <td class="mono">${fmtBytes(c.rx)}</td>
        <td class="mono">${fmtBytes(c.tx)}</td>
      </tr>`).join("");
  } catch (e) {
    const tbody = document.getElementById("wg-table");
    tbody.innerHTML = '<tr><td colspan="6" class="mono">ошибка wg-easy API</td></tr>';
  }
}

function tick() {
  pollSystem();
  pollWg();
}

document.getElementById("th-status").addEventListener("click", () => {
  statusSortDir *= -1;
  document.getElementById("sort-arrow").textContent = statusSortDir === -1 ? "▼" : "▲";
  pollWg();
});

tick();
setInterval(tick, POLL_MS);
