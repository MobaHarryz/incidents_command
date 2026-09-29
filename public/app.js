import { analyze } from '../src/engine/analyze.js';

const FILES = {
  'server.log': ['serverLog', false],
  'deploy.log': ['deployLog', false],
  'carrier.log': ['carrierLog', false],
  'client-heartbeats.json': ['heartbeats', true],
  'seats.json': ['seats', true],
};
const SOURCES = { server: 'Servidor', deploy: 'Deploy', carrier: 'Carrier', heartbeat: 'Heartbeats' };

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const t = (ms) => new Date(ms).toISOString().slice(11, 19);
const domId = (id) => `ev-${id.replace(/[^\w-]/g, '_')}`;
// Texto con `código` → <code>; siempre escapado primero.
const rich = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>');

let input = {};
let report = null;
const filter = { sources: new Set(Object.keys(SOURCES)), onlyProblems: false };

async function loadDefault() {
  const next = {};
  await Promise.all(Object.entries(FILES).map(async ([name, [key, json]]) => {
    const res = await fetch(`data/${name}`);
    if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
    next[key] = json ? await res.json() : await res.text();
  }));
  return next;
}

function run(nextInput, notice) {
  input = nextInput;
  report = analyze(input);
  render();
  showNotice(notice);
}

function showNotice(msg) {
  const n = $('notice');
  n.hidden = !msg;
  n.textContent = msg ?? '';
}

// ---------------------------------------------------------------------------

function render() {
  const r = report;
  const { meta } = r;
  $('meta').textContent = `Ventana ${t(Date.parse(meta.logStart))}–${t(Date.parse(meta.logEnd))} UTC · ${meta.logStart.slice(0, 10)} · build del servidor ${meta.serverBuild ?? '¿?'} · ${r.timeline.length} eventos`;
  $('severity').textContent = r.severity;
  $('headline').textContent = r.headline;
  renderSteps(r.recommendation);
  renderImpact(r.impact);
  renderIncidents(r.incidents);
  for (const k of ['known', 'inferred', 'verify']) {
    $(k).innerHTML = r.findings[k].map((f) => `<li>${rich(f.text)}${refsHtml(f.refs)}</li>`).join('') || '<li>—</li>';
  }
  renderSwimlane(r);
  renderSeats(r.seats);
  renderHypotheses(r.hypotheses);
  renderFilters();
  renderTimeline();
}

const refsHtml = (refs) => (refs?.length
  ? `<div class="refs">${[...new Set(refs)].map((id) => `<button type="button" class="ref" data-ref="${esc(id)}" title="Ver en la línea de tiempo">${esc(id)}</button>`).join('')}</div>`
  : '');

function renderSteps(rec) {
  $('steps').innerHTML = rec.steps.map((s) => `
    <li>
      <div class="act">${rich(s.action)}</div>
      <div class="why">${rich(s.why)}</div>
      ${s.branch ? `<div class="branch"><b>Según el resultado:</b> ${rich(s.branch)}</div>` : ''}
      <span class="risk">Riesgo: ${esc(s.risk)}</span>
    </li>`).join('');
  $('later').innerHTML = rec.later.map((l) => `<li>${rich(l)}</li>`).join('');
  $('donot').innerHTML = rec.doNot.map((d) => `<li>${rich(d)}</li>`).join('');
}

function renderImpact(im) {
  const c = im.confirmed;
  const risk = im.atRisk;
  $('impact').innerHTML = `
    <div class="kpis">
      <div class="kpi bad"><div class="n">${c.seats.length}<small>/${c.totalSeats}</small></div><div class="l">asientos caídos</div></div>
      <div class="kpi ${c.activeCalls.length ? 'bad' : ''}"><div class="n">${c.activeCalls.length}</div><div class="l">llamadas activas afectadas</div></div>
      <div class="kpi warn"><div class="n">${risk ? risk.activeCalls.length : 0}</div><div class="l">llamadas activas en riesgo</div></div>
    </div>
    <div class="tier known"><b>Confirmado</b>
      <p>${c.seats.length ? `${esc(c.seats.join(', '))} sin conexión, en ${esc(c.agencies.join(' y '))}. Ninguno tenía una llamada activa, así que lo que se pierde es capacidad para recibir llamadas nuevas.` : 'Sin asientos caídos.'}
      ${c.suspect.length ? ` Sospechosos: ${esc(c.suspect.join(', '))}.` : ''}</p></div>
    ${risk ? `<div class="tier inferred"><b>En riesgo (inferido)</b><p>${esc(risk.reason)} Serían ${risk.seats.length} asientos más, con llamadas en curso en ${esc(risk.activeCalls.join(', '))}.</p></div>` : ''}
    ${im.external.map((e) => `<div class="tier verify"><b>Externo: carrier ${esc(e.carrier)}</b><p>${e.failed}/${e.total} peticiones fallidas. No sabemos cuántos usuarios cotizan con ${esc(e.carrier)}.</p></div>`).join('')}`;
}

function renderIncidents(list) {
  $('incidents').innerHTML = list.map((i) => `
    <article class="inc">
      <div class="top">
        <span class="badge s${esc(i.severity.slice(-1))}">${esc(i.severity)}</span>
        <span class="badge status">${esc(i.status)}</span>
        ${i.userFacing ? '<span class="badge user">afecta a usuarios</span>' : ''}
      </div>
      <h3>${esc(i.title)}</h3>
      <p>${t(i.startMs)}–${t(i.lastEvidenceMs)} UTC</p>
      <p>${esc(i.summary)}</p>
      ${refsHtml(i.refs)}
    </article>`).join('');
}

const VERDICT_CLASS = (v) => (/descartada/.test(v) ? 'rejected' : /más probable|^probable/.test(v) ? 'likely' : /confirmada/.test(v) ? 'confirmed' : 'unproven');
const KIND = { known: 'dato', inferred: 'inferencia', verify: 'por verificar' };
const evList = (xs) => xs.map((f) => `<li><span class="kind ${f.kind}">${KIND[f.kind]}</span>${rich(f.text)}${refsHtml(f.refs)}</li>`).join('') || '<li>—</li>';

function renderHypotheses(list) {
  $('hypotheses').innerHTML = list.map((h) => `
    <article class="hyp ${VERDICT_CLASS(h.verdict)}">
      <div class="top">
        <h3><span class="id">${esc(h.id)}</span>${esc(h.title)}</h3>
        <span class="verdict ${VERDICT_CLASS(h.verdict)}">${esc(h.verdict)}</span>
      </div>
      <div class="conf"><span>Confianza</span><span class="bar"><i style="width:${Math.round(h.confidence * 100)}%"></i></span><span>${Math.round(h.confidence * 100)}%</span></div>
      <div class="ev-cols">
        <div class="pro"><h4>A favor</h4><ul>${evList(h.for)}</ul></div>
        <div class="con"><h4>En contra / límites</h4><ul>${evList(h.against)}</ul></div>
      </div>
    </article>`).join('');
}

function renderSeats(seats) {
  const byAgency = new Map();
  for (const s of seats) {
    const k = s.agency ?? 'Sin agencia';
    if (!byAgency.has(k)) byAgency.set(k, []);
    byAgency.get(k).push(s);
  }
  const builds = seats.map((s) => s.build).filter(Boolean).sort();
  const newest = builds[builds.length - 1];
  const label = { down: 'caído', suspect: 'sospechoso', ok: 'reportando', unknown: 'sin datos' };
  $('seats').innerHTML = [...byAgency].map(([agency, list]) => `
    <div class="agency">
      <h3>${esc(agency)} · ${list.filter((s) => s.status !== 'ok').length}/${list.length} con problemas</h3>
      <div class="seatgrid">
        ${list.map((s) => `
          <button type="button" class="seat ${s.status}" data-ref="${esc(s.refs[s.refs.length - 1] ?? '')}"
            title="${esc(`${s.seat}: ${label[s.status]}\nÚltimo heartbeat: ${s.lastSeen ?? '—'}\nBuild: ${s.build ?? '—'}\nLlamada activa: ${s.activeCall ? 'sí' : 'no'}`)}">
            ${s.activeCall ? '<span class="call" aria-label="llamada activa">●</span>' : ''}
            ${s.build && s.build !== newest ? '<span class="oldb" aria-label="build antiguo">v</span>' : ''}
            ${esc(s.seat)}<small>${s.lastSeenMs ? t(s.lastSeenMs) : '—'}</small>
          </button>`).join('')}
      </div>
    </div>`).join('');
}

function renderSwimlane(r) {
  const lanes = Object.keys(SOURCES);
  const W = 760, L = 88, R = 16, T = 26, LH = 40, H = T + lanes.length * LH + 26;
  const ev = r.timeline;
  const min = Math.min(...ev.map((e) => e.ms)) - 20_000;
  const max = Math.max(...ev.map((e) => e.ms)) + 20_000;
  const x = (ms) => L + ((ms - min) / (max - min)) * (W - L - R);
  const y = (lane) => T + lanes.indexOf(lane) * LH + LH / 2;
  const parts = [];

  const dw = r.markers.deployWindow;
  if (dw) {
    parts.push(`<rect class="band" x="${x(dw.start)}" y="${T - 4}" width="${Math.max(4, x(dw.end) - x(dw.start))}" height="${lanes.length * LH + 8}"><title>Ventana del deploy ${esc(dw.build)}</title></rect>`);
    parts.push(`<text class="mark" x="${x(dw.start) + 3}" y="${T - 8}">deploy ${esc(dw.build)}</text>`);
  }
  for (let m = Math.ceil(min / 60_000) * 60_000; m <= max; m += 60_000) {
    parts.push(`<line class="lane" x1="${x(m)}" x2="${x(m)}" y1="${T}" y2="${T + lanes.length * LH}" stroke-dasharray="2 4"/>`);
    parts.push(`<text x="${x(m)}" y="${H - 8}" text-anchor="middle">${t(m).slice(0, 5)}</text>`);
  }
  lanes.forEach((lane) => {
    parts.push(`<line class="lane" x1="${L}" x2="${W - R}" y1="${y(lane)}" y2="${y(lane)}"/>`);
    parts.push(`<text x="8" y="${y(lane) + 4}">${SOURCES[lane]}</text>`);
  });
  const onset = r.markers.seatOutageOnset;
  if (onset) {
    parts.push(`<line class="onset" x1="${x(onset)}" x2="${x(onset)}" y1="${T - 4}" y2="${T + lanes.length * LH + 4}"/>`);
    parts.push(`<text class="mark red" x="${x(onset) - 3}" y="${T - 8}" text-anchor="end">caída de asientos</text>`);
  }

  // Heartbeats: agrupados por instante (sanos vs. caídos) para no apilar 17 puntos.
  const seatStatus = new Map(r.seats.map((s) => [s.seat, s.status]));
  const groups = new Map();
  for (const e of ev.filter((e) => e.source === 'heartbeat')) {
    const bad = seatStatus.get(e.fields.seat) !== 'ok';
    const k = `${e.ms}|${bad}`;
    if (!groups.has(k)) groups.set(k, { ms: e.ms, bad, ids: [] });
    groups.get(k).ids.push(e);
  }
  for (const g of groups.values()) {
    const rad = Math.min(11, 4 + Math.sqrt(g.ids.length) * 1.8);
    const names = g.ids.map((e) => e.fields.seat).join(', ');
    parts.push(`<circle class="ev ${g.bad ? 'error' : 'okbeat'}" data-ref="${esc(g.ids[0].id)}" cx="${x(g.ms)}" cy="${y('heartbeat')}" r="${rad}"><title>${t(g.ms)}Z · último heartbeat de ${g.ids.length} asiento(s): ${esc(names)}</title></circle>`);
    parts.push(`<text x="${x(g.ms)}" y="${y('heartbeat') + rad + 11}" text-anchor="middle">${g.ids.length}</text>`);
  }
  const seen = new Map();
  for (const e of ev.filter((e) => e.source !== 'heartbeat')) {
    const k = `${e.source}|${Math.round(x(e.ms) / 6)}`;
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    const dy = n === 0 ? 0 : (n % 2 ? -1 : 1) * Math.ceil(n / 2) * 7;
    parts.push(`<circle class="ev ${e.level}" data-ref="${esc(e.id)}" cx="${x(e.ms)}" cy="${y(e.source) + dy}" r="5"><title>${t(e.ms)}Z · ${esc(e.message)}</title></circle>`);
  }
  $('swimlane').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Eventos por fuente a lo largo del tiempo">${parts.join('')}</svg>`;
}

function renderFilters() {
  const chips = Object.entries(SOURCES).map(([k, label]) =>
    `<button type="button" class="chip" data-src="${k}" aria-pressed="${filter.sources.has(k)}">${label}</button>`);
  chips.push(`<button type="button" class="chip" data-problems aria-pressed="${filter.onlyProblems}">Solo warn/error</button>`);
  $('filters').innerHTML = chips.join('');
}

function renderTimeline() {
  const dw = report.markers.deployWindow;
  const rows = [];
  let dividerDone = false;
  for (const e of report.timeline) {
    if (!filter.sources.has(e.source)) continue;
    if (filter.onlyProblems && e.level === 'info' && !(e.source === 'heartbeat' && isStaleBeat(e))) continue;
    if (dw && !dividerDone && e.ms >= dw.start) {
      rows.push(`<tr class="divider"><td colspan="5">▼ Ventana del deploy ${esc(dw.build)} (${t(dw.start)}–${t(dw.end)} UTC)</td></tr>`);
      dividerDone = true;
    }
    const inDeploy = dw && e.ms >= dw.start && e.ms <= dw.end;
    const level = e.source === 'heartbeat' && isStaleBeat(e) ? 'error' : e.level;
    rows.push(`<tr id="${domId(e.id)}" class="${level}${inDeploy ? ' in-deploy' : ''}">
      <td>${t(e.ms)}</td>
      <td><span class="src">${esc(e.id)}</span></td>
      <td><span class="lvl ${level}">${level}</span></td>
      <td>${esc(e.message)}</td>
      <td>${e.tzOffset !== 'Z' ? `<span class="tz" title="Hora original en ${esc(e.tzOffset)}">${esc(e.rawTs.slice(11))}</span>` : '='}</td>
    </tr>`);
  }
  $('timeline').innerHTML = rows.join('') || '<tr><td colspan="5">Sin eventos con estos filtros.</td></tr>';
}

const isStaleBeat = (e) => report.seats.find((s) => s.seat === e.fields.seat)?.status !== 'ok';

function focusRef(id) {
  if (!id) return;
  const ev = report.timeline.find((e) => e.id === id);
  if (ev && (!filter.sources.has(ev.source) || filter.onlyProblems)) {
    filter.sources.add(ev.source);
    filter.onlyProblems = false;
    renderFilters();
    renderTimeline();
  }
  const row = document.getElementById(domId(id));
  if (!row) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('hl');
  setTimeout(() => row.classList.remove('hl'), 2500);
}

// ---------------------------------------------------------------------------

document.addEventListener('click', (e) => {
  const ref = e.target.closest('[data-ref]');
  if (ref) return focusRef(ref.dataset.ref);
  const chip = e.target.closest('.chip');
  if (!chip) return;
  if ('problems' in chip.dataset) filter.onlyProblems = !filter.onlyProblems;
  else if (filter.sources.has(chip.dataset.src)) filter.sources.delete(chip.dataset.src);
  else filter.sources.add(chip.dataset.src);
  renderFilters();
  renderTimeline();
});

$('files').addEventListener('change', async (e) => {
  const next = { ...input };
  const loaded = [];
  const ignored = [];
  for (const file of e.target.files) {
    const entry = FILES[file.name];
    if (!entry) { ignored.push(file.name); continue; }
    const [key, json] = entry;
    try {
      const text = await file.text();
      next[key] = json ? JSON.parse(text) : text;
      loaded.push(file.name);
    } catch (err) {
      ignored.push(`${file.name} (${err.message})`);
    }
  }
  e.target.value = '';
  try {
    run(next, `Cargados: ${loaded.join(', ') || 'ninguno'}.${ignored.length ? ` Ignorados: ${ignored.join(', ')}. Nombres esperados: ${Object.keys(FILES).join(', ')}.` : ''} Las fuentes que no cargaste se mantienen.`);
  } catch (err) {
    showNotice(`No se pudo analizar: ${err.message}`);
  }
});

$('reset').addEventListener('click', async () => run(await loadDefault(), 'Datos de ejemplo restaurados.'));

try {
  run(await loadDefault());
} catch (err) {
  showNotice(`No se pudieron cargar los datos de ejemplo (${err.message}). Abre la app con \`npm start\` o carga los archivos manualmente.`);
}
