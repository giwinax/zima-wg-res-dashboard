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

// Сортировка таблицы WireGuard-клиентов. По умолчанию — по статусу, online сверху.
let sortKey = "status";
let sortDir = -1; // -1 = по умолчанию для ключа (см. sortValue), 1 = обратный

function sortValue(c, key) {
  switch (key) {
    case "name": return c.name || "";
    case "status": return c.online ? 1 : 0;
    case "address": return c.address || "";
    case "handshake": return c.last_handshake ? new Date(c.last_handshake).getTime() : -Infinity;
    case "rx": return c.rx || 0;
    case "tx": return c.tx || 0;
    default: return "";
  }
}

function applySort(clients) {
  const key = sortKey;
  const dir = sortDir;
  const sorted = [...clients].sort((a, b) => {
    const va = sortValue(a, key), vb = sortValue(b, key);
    let cmp;
    if (typeof va === "string") cmp = va.localeCompare(vb);
    else cmp = va < vb ? -1 : va > vb ? 1 : 0;
    if (cmp !== 0) return cmp * dir;
    return (a.name || "").localeCompare(b.name || "");
  });
  return sorted;
}

function updateSortArrows() {
  document.querySelectorAll("th.sortable").forEach(th => {
    const arrow = th.querySelector(".sort-arrow");
    if (th.dataset.sort === sortKey) {
      arrow.textContent = sortDir === 1 ? "▲" : "▼";
    } else {
      arrow.textContent = "";
    }
  });
}

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
    const sorted = applySort(withStatus);
    updateSortArrows();
    tbody.innerHTML = sorted.map(c => `<tr>
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

// OpenFlux: хвост docker-лога контейнера openflux. Строки ставятся через
// textContent, не innerHTML: это внешние данные.
const OF_POLL_MS = 3000;
let ofLastKey = "";

function ofClass(m) {
  if (/fail|error|ошибк|refus|denied|timed out|не отвечают/i.test(m)) return "err";
  if (/warn|retry|reconnect|still not up|switched|took over/i.test(m)) return "warn";
  if (/started|established|auth OK|зашли в|Running as EXIT/i.test(m)) return "ok";
  return "";
}

async function pollOpenflux() {
  const box = document.getElementById("of-logs");
  const status = document.getElementById("of-status");
  const noise = document.getElementById("of-noise").checked;
  try {
    const r = await fetch("/api/openflux/logs?lines=300&noise=" + noise);
    const d = await r.json();
    if (!r.ok) {
      status.textContent = "· лог не найден (" + (d.container || "openflux") + ")";
      return;
    }
    const last = d.lines.length ? d.lines[d.lines.length - 1] : null;
    const key = noise + "|" + d.lines.length + "|" + (last ? last.t : "");
    status.textContent = "· " + d.lines.length + " строк";
    if (key === ofLastKey) return;
    ofLastKey = key;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    const frag = document.createDocumentFragment();
    if (!d.lines.length) {
      const s = document.createElement("span");
      s.className = "ln ts";
      s.textContent = "пусто";
      frag.appendChild(s);
    }
    for (const l of d.lines) {
      const row = document.createElement("span");
      row.className = "ln " + ofClass(l.m);
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = l.t ? new Date(l.t).toLocaleTimeString("ru-RU") : "";
      row.appendChild(ts);
      row.appendChild(document.createTextNode(l.m));
      frag.appendChild(row);
    }
    box.replaceChildren(frag);
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch (e) {
    status.textContent = "· ошибка API";
  }
}

document.getElementById("of-noise").addEventListener("change", () => {
  ofLastKey = "";
  pollOpenflux().then(() => {
    const box = document.getElementById("of-logs");
    box.scrollTop = box.scrollHeight;
  });
});

function tick() {
  pollSystem();
  pollWg();
}

document.querySelectorAll("th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (sortKey === key) {
      sortDir *= -1;
    } else {
      sortKey = key;
      // статус и handshake по умолчанию "больше/новее сверху", остальное - по возрастанию
      sortDir = (key === "status" || key === "handshake") ? -1 : 1;
    }
    pollWg();
  });
});

tick();
setInterval(tick, POLL_MS);
pollOpenflux().then(() => {
  const box = document.getElementById("of-logs");
  box.scrollTop = box.scrollHeight;
});
setInterval(pollOpenflux, OF_POLL_MS);
