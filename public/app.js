// Display-only status page: subscribes to /api/events (SSE) and renders Punto 2 markup.
// No inputs. Components are written as the same HTML the React ones in aitorru/desing emit.
import { dotPattern } from "/dotpattern.js";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const TONE = { up: "ok", degraded: "warn", down: "error", unknown: "idle" };
const WORD = { up: "Operativo", degraded: "Degradado", down: "Caído", unknown: "Sin datos" };
const LOG_LEVEL = { up: "ok", degraded: "warn", down: "error", unknown: "info", resolved: "ok", reopened: "error" };
const SAMPLE_TONE = { u: "ok", d: "warn", x: "error", "-": "idle" };

let snap = null;
let connected = false;

// ── Formatting ──────────────────────────────────────────────────
const dur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const ago = (t) => `<span data-ago="${t}">${dur(Date.now() - t)}</span>`;
const clock = (t) => new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hm = (t) => new Date(t).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
const pct = (u) => (u == null ? "—" : `${(u * 100).toFixed(u === 1 ? 0 : 1).replace(".", ",")} %`);
const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;

// ── Punto components, as HTML ───────────────────────────────────
const Status = (tone, label, pulse = tone === "running") =>
  `<span class="pt-status pt-status--${tone}"><span class="pt-status__dot${pulse ? " pt-status__dot--pulse" : ""}" aria-hidden="true"></span><span class="pt-status__label">${label}</span></span>`;

const DotUptime = (tones, label, rows = 1, size = 8) => {
  const clean = tones.filter((t) => t === "ok").length;
  return `<div role="img" aria-label="${esc(label)}: ${clean} de ${tones.length} sin incidencias" class="pt-uptime" style="--rows:${rows};--dot:${size}px">${tones
    .map((t) => `<span class="pt-uptime__dot pt-uptime__dot--${t}"></span>`)
    .join("")}</div>`;
};

const Stat = ({ label, value, note, delta, trend = "neutral", chart }) => `<div class="pt-stat pt-stat--md">
  <div class="pt-stat__top"><span class="pt-eyebrow">${label}</span>${delta ? `<span class="pt-badge pt-badge--${trend}"><span class="pt-badge__dot"></span>${delta}</span>` : ""}</div>
  <p class="pt-display pt-stat__value">${value}</p>
  ${note ? `<p class="pt-stat__note">${note}</p>` : ""}
  ${chart ? `<div class="pt-stat__chart">${chart}</div>` : ""}
</div>`;

const Glass = (body, { tone = "clear", pad = "md", backdrop = "" } = {}) =>
  `<div class="pt-glass pt-glass--${tone} pt-glass--pad-${pad}">${backdrop ? `<div class="pt-glass__backdrop">${backdrop}</div>` : ""}<div class="pt-glass__body">${body}</div></div>`;

const SectionHeader = ({
  index,
  eyebrow,
  title,
  description,
  actions,
  size = "sm",
  level = 2,
}) => `<header class="pt-sectionheader pt-sectionheader--${size} pt-sectionheader--start">
  <div class="pt-sectionheader__text">
    <span class="pt-sectionheader__eyebrow">${index ? `<span class="pt-folio">${index}</span>` : ""}${eyebrow ? `<span class="pt-eyebrow">${eyebrow}</span>` : ""}</span>
    <h${level} class="pt-display pt-sectionheader__title">${title}</h${level}>
    ${description ? `<p class="pt-body pt-sectionheader__lead">${description}</p>` : ""}
  </div>
  ${actions ? `<div class="pt-sectionheader__actions">${actions}</div>` : ""}
</header>`;

/** A page section's title: its number and its name are the heading, with no subtitle. */
const SectionTitle = (index, title, actions) =>
  SectionHeader({ title: `<span class="hp-sec__n">${index}</span>${title}`, actions });

const KeyValue = (items) =>
  `<dl class="pt-kv pt-kv--leaders">${items
    .map(
      (i) =>
        `<div class="pt-kv__row"><dt class="pt-kv__label">${i.label}</dt><span class="pt-kv__leader" aria-hidden="true"></span><dd class="pt-kv__value${i.mono ? " pt-mono" : ""}">${i.value}</dd></div>`,
    )
    .join("")}</dl>`;

const LEVEL_TEXT = { debug: "DBG", info: "INF", ok: "OK", warn: "WRN", error: "ERR" };
const LogView = (entries, label) =>
  `<div role="log" aria-label="${esc(label)}" tabindex="0" class="pt-log pt-log--wrap">${entries
    .map(
      (e) => `<div class="pt-log__line pt-log__line--${e.level}">
      <time class="pt-log__time">${e.time}</time>
      <span class="pt-log__level"><span class="pt-log__dot" aria-hidden="true"></span>${LEVEL_TEXT[e.level]}</span>
      ${e.source ? `<span class="pt-log__source">${esc(e.source)}</span>` : ""}
      <span class="pt-log__msg">${esc(e.message)}</span>
    </div>`,
    )
    .join("")}</div>`;

const DataTable = ({
  caption,
  columns,
  rows,
  selected = () => false,
  compact = false,
}) => `<div class="pt-table${compact ? " pt-table--compact" : ""}">
  <table class="pt-table__table">
    <caption class="pt-sr-only">${caption}</caption>
    <thead><tr>${columns.map((c) => `<th scope="col" class="pt-table__th${c.end ? " is-end" : ""}${c.cls ? ` ${c.cls}` : ""}">${c.header}</th>`).join("")}</tr></thead>
    <tbody>${rows
      .map(
        (r) =>
          `<tr class="pt-table__row${selected(r) ? " is-selected" : ""}">${columns
            .map(
              (c) =>
                `<td class="pt-table__td${c.end ? " is-end" : ""}${c.mono ? " pt-mono" : ""}${c.cls ? ` ${c.cls}` : ""}">${c.cell(r)}</td>`,
            )
            .join("")}</tr>`,
      )
      .join("")}</tbody>
  </table>
</div>`;

const issueLink = (inc) => {
  if (!inc?.issue) return snap.gitlab.mode === "live" ? Status("running", "abriendo issue") : "—";
  const label = `#${inc.issue.iid}`;
  return inc.issue.url
    ? `<a href="${esc(inc.issue.url)}" target="_blank" rel="noopener">${label} ↗</a>`
    : `${label} (dry-run)`;
};

// ── Sections ────────────────────────────────────────────────────
function renderMast() {
  $("brand-title").textContent = snap?.title ?? "Estado de servicios";
  $("issue").textContent = snap
    ? snap.gitlab.mode === "live"
      ? `GitLab · ${snap.gitlab.project}`
      : "GitLab · dry-run"
    : "";
}

function renderLive() {
  const el = $("live");
  el.className = "hp-live";
  if (!connected || !snap) {
    el.innerHTML = `<span class="pt-dotloader pt-dotloader--wave">${[0, 1, 2].map((i) => `<span class="pt-dotloader__dot" style="--i:${i}"></span>`).join("")}</span> Reconectando`;
    return;
  }
  el.innerHTML = `<span class="hp-live__time">Actualizado ${snap.lastTickAt ? clock(snap.lastTickAt) : "—"}</span>${Status("running", "En directo")}`;
}

function renderHead() {
  const { services, active, overall } = snap;
  const count = (s) => services.filter((x) => x.status === s).length;
  const [up, degraded, down, unknown] = ["up", "degraded", "down", "unknown"].map(count);
  const title =
    overall === "up"
      ? "Todo <em>funciona</em>"
      : down
        ? down === 1
          ? "Un servicio <em>caído</em>"
          : `${down} servicios <em>caídos</em>`
        : degraded === 1
          ? "Un servicio <em>degradado</em>"
          : `${degraded} servicios <em>degradados</em>`;
  const description = active.length
    ? `${active
        .map(
          (i) =>
            `${esc(i.serviceName)} ${WORD[i.status].toLowerCase()} desde hace ${ago(i.startedAt)}${i.issue ? ` (issue #${i.issue.iid})` : ""}`,
        )
        .join("; ")}.`
    : "";
  const statuses = [
    up && Status("ok", n(up, "operativo", "operativos")),
    degraded && Status("warn", n(degraded, "degradado", "degradados")),
    down && Status("error", n(down, "caído", "caídos")),
    unknown && Status("idle", "sin datos"),
  ].filter(Boolean);
  // The pattern is only redrawn when its motion changes, so the breath is never cut short.
  const motion = overall === "up" ? "still" : "breathe";
  const head = $("head");
  if (head.dataset.motion !== motion) {
    head.dataset.motion = motion;
    head.innerHTML = `${dotPattern({ motif: "diagonal", anchor: "top-right", cols: 72, rows: 34, period: 6, highlight: 4, intensity: 0.3, motion })}<div id="head-body" class="hp-head-body"></div>`;
  }
  $("head-body").innerHTML = `  ${SectionHeader({
    size: "lg",
    level: 1,
    index: "Producción",
    eyebrow: `${n(services.length, "servicio", "servicios")} · comprobación cada ${snap.intervalSeconds} s`,
    title,
    description,
  })}
  <div class="pt-stack pt-stack--row pt-stack--wrap fm-head__actions" style="--gap: var(--pt-space-5)">${statuses.join("")}</div>`;
  document.title = `${overall === "up" ? "●" : "▲"} ${snap.title}`;
}

/** One sample per tick for the whole platform: the worst service at that moment. */
function platformHistory() {
  const rank = { "-": 0, u: 1, d: 2, x: 3 };
  const out = Array(snap.historySize).fill("-");
  for (const s of snap.services) {
    const h = s.history.padStart(snap.historySize, "-");
    for (let i = 0; i < h.length; i++) if (rank[h[i]] > rank[out[i]]) out[i] = h[i];
  }
  return out.map((c) => SAMPLE_TONE[c]);
}

function renderStats() {
  const { services, active, resolved } = snap;
  const counted = services.filter((s) => s.uptime != null);
  const uptime = counted.length ? counted.reduce((a, s) => a + s.uptime, 0) / counted.length : null;
  const http = services.filter((s) => s.source.kind === "http" && s.latencyMs != null && s.status !== "down");
  const latency = http.length ? Math.round(http.reduce((a, s) => a + s.latencyMs, 0) / http.length) : null;
  const slowest = http.toSorted((a, b) => b.latencyMs - a.latencyMs)[0];
  const span = dur(snap.historySize * snap.intervalSeconds * 1000);
  const last = resolved[0];
  const plate = dotPattern({
    motif: "orb",
    anchor: "bottom-right",
    origin: "bottom-right",
    cols: 24,
    rows: 24,
    highlight: 2,
    intensity: 0.5,
    style: "--pt-pattern-accent: var(--pt-spectrum-6)",
  });
  $("stats").innerHTML = [
    Glass(
      Stat({
        label: `Disponibilidad · ${span}`,
        value: pct(uptime),
        chart: DotUptime(platformHistory(), "Estado de la plataforma por comprobación", 3),
      }),
    ),
    Glass(
      Stat({
        label: "Latencia HTTP media",
        value: latency == null ? "—" : `${latency} ms`,
        note: slowest ? `la más lenta: ${esc(slowest.name)} · ${slowest.latencyMs} ms` : "sin servicios HTTP",
      }),
    ),
    Glass(
      Stat({
        label: "Resueltas recientemente",
        value: String(resolved.length),
        note: last ? `última: ${esc(last.serviceName)} · hace ${ago(last.resolvedAt)}` : "nada todavía",
      }),
    ),
    Glass(
      Stat({
        label: "Incidencias abiertas",
        value: String(active.length),
        note: active.length ? active.map((i) => esc(i.serviceName)).join(" · ") : "ninguna",
      }),
      { tone: "bloom", backdrop: plate },
    ),
  ].join("");
}

/** Uptime colour: green when clean, amber below 99 %, red below 95 %. */
const uptimeTone = (u) => (u == null ? "idle" : u >= 0.99 ? "ok" : u >= 0.95 ? "warn" : "error");

function renderServices() {
  const columns = [
    {
      header: "Servicio",
      mono: true,
      cls: "hp-col-svc",
      cell: (s) =>
        `<span class="hp-svc" style="--svc: var(--pt-spectrum-${(snap.services.indexOf(s) % 6) + 1})">${esc(s.name)}<small>${esc(s.group)}${s.description ? ` · ${esc(s.description)}` : ""}</small></span>`,
    },
    { header: "Estado", cell: (s) => Status(TONE[s.status], WORD[s.status]) },
    {
      header: "Fuente",
      mono: true,
      cls: "hp-col-src",
      cell: (s) => `<span title="${esc(s.source.detail)}">${esc(s.source.kind)}</span>`,
    },
    {
      header: "Historial",
      cls: "hp-col-hist",
      cell: (s) =>
        DotUptime(
          [...s.history.slice(-30).padStart(30, "-")].map((c) => SAMPLE_TONE[c]),
          `Últimas comprobaciones de ${s.name}`,
          1,
          6,
        ),
    },
    {
      header: "Uptime",
      end: true,
      mono: true,
      cell: (s) => `<span class="hp-tone hp-tone--${uptimeTone(s.uptime)}">${pct(s.uptime)}</span>`,
    },
    {
      header: "Latencia",
      end: true,
      mono: true,
      cell: (s) =>
        s.latencyMs == null ? "—" : `<span class="hp-tone hp-tone--${TONE[s.status]}">${s.latencyMs} ms</span>`,
    },
    {
      header: "Última comprobación",
      cls: "hp-col-msg",
      cell: (s) => `<div class="hp-msg" title="${esc(s.message)}">${esc(s.message)}</div>`,
    },
  ];
  $("services").innerHTML = `${SectionTitle("01", "Servicios")}
    <div class="hp-table-wrap">${DataTable({ caption: "Servicios vigilados", columns, rows: snap.services, selected: (s) => Boolean(s.incident) })}</div>`;
}

function renderIncidents() {
  const { active, resolved, gitlab } = snap;
  const where = gitlab.mode === "live" ? `GitLab · ${esc(gitlab.project)}` : "GitLab · dry-run";
  const cards = active.map((i) => {
    const svc = snap.services.find((s) => s.id === i.serviceId);
    const log = i.timeline
      .slice(-8)
      .reverse()
      .map((e) => ({ time: clock(e.t), level: LOG_LEVEL[e.status] ?? "info", message: e.text }));
    return Glass(`<div class="hp-inc">
      <div class="hp-inc__head"><h3 class="pt-display hp-inc__title">${esc(i.serviceName)}</h3>${Status(TONE[i.status], WORD[i.status], true)}</div>
      <div class="fm-cols--even">
        ${KeyValue([
          { label: "Issue", value: issueLink(i), mono: true },
          { label: "Inicio", value: hm(i.startedAt), mono: true },
          { label: "Duración", value: ago(i.startedAt) },
          { label: "Peor estado", value: WORD[i.worst] },
          { label: "Comprobaciones fallidas", value: String(i.failedChecks), mono: true },
          { label: "Fuente", value: esc(svc?.source.kind ?? "—"), mono: true },
        ])}
        ${LogView(log, `Cronología de ${i.serviceName}`)}
      </div>
    </div>`);
  });
  const past = resolved.length
    ? DataTable({
        caption: "Incidencias resueltas",
        compact: true,
        columns: [
          { header: "Servicio", mono: true, cell: (i) => esc(i.serviceName) },
          { header: "Peor estado", cell: (i) => Status(TONE[i.worst], WORD[i.worst]) },
          { header: "Duración", end: true, mono: true, cell: (i) => dur(i.resolvedAt - i.startedAt) },
          { header: "Resuelta", end: true, cls: "hp-col-msg", cell: (i) => `hace ${ago(i.resolvedAt)}` },
          { header: "Issue", end: true, mono: true, cell: issueLink },
        ],
        rows: resolved,
      })
    : "";
  $("incidents").innerHTML = `${SectionTitle("02", "Incidencias", `<span class="pt-folio">${where}</span>`)}
  ${cards.join("") || Glass(`<div class="hp-empty">${Status("ok", "Sin incidencias abiertas")}</div>`)}
  ${past ? `<span class="pt-eyebrow">Resueltas recientemente</span><div class="hp-table-wrap">${past}</div>` : ""}`;
}

function renderLog() {
  const all = [...snap.active, ...snap.resolved]
    .flatMap((i) => i.timeline.map((e) => ({ ...e, source: i.serviceId })))
    .sort((a, b) => b.t - a.t)
    .slice(0, 14);
  const width = Math.max(...snap.services.map((s) => s.id.length));
  $("log").innerHTML = `${SectionTitle("03", "Registro", Status("running", "En directo"))}
    ${
      all.length
        ? LogView(
            all.map((e) => ({
              time: clock(e.t),
              level: LOG_LEVEL[e.status] ?? "info",
              source: e.source.padEnd(width),
              message: e.text,
            })),
            "Registro de incidencias",
          )
        : Glass(`<div class="hp-empty">${Status("idle", "Sin eventos todavía")}</div>`)
    }`;
}

// ── Favicon ─────────────────────────────────────────────────────
// The brand's nine dots in the colour of the platform; when something is down they turn red
// and only the diagonals stay, so the tab says it without colour too. Grey while reconnecting.
const FAVICON = { up: "#2f9e6e", degraded: "#d08a1c", down: "#f23f6b", unknown: "#8a8a8a" };
function renderFavicon() {
  const state = connected && snap ? snap.overall : "unknown";
  const el = $("favicon");
  if (!el || el.dataset.state === state) return;
  el.dataset.state = state;
  const dots = [];
  for (const y of [4, 12, 20])
    for (const x of [4, 12, 20])
      if (state !== "down" || x === y || x + y === 24)
        dots.push(`<circle cx="${x}" cy="${y}" r="${state === "down" ? 3.2 : 2.6}"/>`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><g fill="${FAVICON[state] ?? FAVICON.unknown}">${dots.join("")}</g></svg>`;
  el.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// ── Theme switch ────────────────────────────────────────────────
// Punto's ThemeSwitch (icons, sm) and useTheme: the choice is kept in localStorage under
// pt-theme, `system` follows the device with OLED at night. A ?theme= in the URL wins on load.
const THEME_KEY = "pt-theme";
const THEMES = ["system", "light", "dark", "oled"];
const THEME_LABEL = { system: "Sistema", light: "Claro", dark: "Oscuro", oled: "OLED" };
const darkMq = matchMedia("(prefers-color-scheme: dark)");
let themePref = (() => {
  const pinned = new URLSearchParams(location.search).get("theme");
  if (THEMES.includes(pinned)) return pinned;
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEMES.includes(stored) ? stored : "system";
  } catch {
    return "system";
  }
})();
const applyTheme = () =>
  document.documentElement.setAttribute(
    "data-pt-theme",
    themePref === "system" ? (darkMq.matches ? "oled" : "light") : themePref,
  );
function renderTheme() {
  $("theme").innerHTML =
    `<fieldset class="pt-themeswitch pt-themeswitch--sm pt-themeswitch--icons" style="--n:${THEMES.length};--i:${THEMES.indexOf(themePref)}">
    <legend class="pt-sr-only">Tema</legend>
    <span class="pt-themeswitch__thumb" aria-hidden="true"></span>
    ${THEMES.map(
      (t) => `<label class="pt-themeswitch__item${t === themePref ? " is-active" : ""}" title="${THEME_LABEL[t]}">
      <input type="radio" class="pt-themeswitch__input" name="pt-theme" value="${t}"${t === themePref ? " checked" : ""} />
      <span class="pt-themeswitch__glyph pt-themeswitch__glyph--${t}" aria-hidden="true"></span>
      <span class="pt-sr-only">${THEME_LABEL[t]}</span>
    </label>`,
    ).join("")}
  </fieldset>`;
}
$("theme").addEventListener("change", (e) => {
  themePref = e.target.value;
  try {
    localStorage.setItem(THEME_KEY, themePref);
  } catch {
    // Private mode or storage disabled: the choice lasts for this page only.
  }
  applyTheme();
  renderTheme();
  $("theme").querySelector(`input[value="${themePref}"]`)?.focus();
});
darkMq.addEventListener("change", applyTheme);
// Another tab changed it: follow.
addEventListener("storage", (e) => {
  if (e.key !== THEME_KEY) return;
  themePref = THEMES.includes(e.newValue) ? e.newValue : "system";
  applyTheme();
  renderTheme();
});

let puntoVersion = "";
function renderFoot() {
  const strip = $("strip");
  const cols = Math.ceil(strip.clientWidth / 8) || 150;
  if (strip.dataset.cols !== String(cols)) {
    strip.dataset.cols = String(cols);
    strip.innerHTML = dotPattern({
      motif: "grid",
      cols,
      rows: 5,
      falloff: 0,
      intensity: 0.34,
      highlight: 0,
      origin: "left",
    });
  }
  if (!snap) return;
  $("foot").innerHTML =
    `<span>Solo lectura · comprobación cada ${snap.intervalSeconds} s · histórico de ${snap.historySize} muestras</span>
    <span>Punto 2, edición formal${puntoVersion ? ` · <span class="pt-mono">desing@${esc(puntoVersion)}</span>` : ""}</span>`;
}

function render() {
  renderMast();
  renderLive();
  renderFavicon();
  renderFoot();
  if (!snap) return;
  renderHead();
  renderStats();
  renderServices();
  renderIncidents();
  renderLog();
}

// ── Wiring ──────────────────────────────────────────────────────
fetch("/punto.version")
  .then((r) => (r.ok ? r.text() : ""))
  .then((v) => {
    puntoVersion = v.trim();
    renderFoot();
  })
  .catch(() => {});

const es = new EventSource("/api/events");
es.onmessage = (ev) => {
  connected = true;
  snap = JSON.parse(ev.data);
  render();
};
es.onerror = () => {
  connected = false;
  renderLive();
  renderFavicon();
};

applyTheme();
renderTheme();
render();
addEventListener("resize", renderFoot);
// Relative times tick locally without re-rendering (keeps pulses and breathing smooth).
setInterval(() => {
  renderLive();
  for (const el of document.querySelectorAll("[data-ago]")) el.textContent = dur(Date.now() - Number(el.dataset.ago));
}, 1000);
