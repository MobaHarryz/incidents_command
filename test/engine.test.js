import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyze } from '../src/engine/analyze.js';
import { parseDeployLog, parseServerLog, parseTimestamp } from '../src/engine/parse.js';
import { loadDir } from '../src/node/load.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const input = await loadDir(DATA);
const report = analyze(input);
const hyp = (id) => report.hypotheses.find((h) => h.id.startsWith(id));

test('normaliza zonas horarias a UTC (deploy.log viene en -05:00)', () => {
  assert.equal(parseTimestamp('2026-09-29T08:04:50-05:00').ts, '2026-09-29T13:04:50Z');
  const [start] = parseDeployLog('2026-09-29T08:04:50-05:00 DEPLOY candidate build=2026.09.29.5');
  assert.equal(start.type, 'deploy.start');
  assert.equal(start.tzOffset, '-05:00');
  assert.equal(start.fields.build, '2026.09.29.5');
});

test('la línea de tiempo queda ordenada cronológicamente entre fuentes', () => {
  const ms = report.timeline.map((e) => e.ms);
  assert.deepEqual(ms, [...ms].sort((a, b) => a - b));
  // el deploy (08:04 local) debe quedar DESPUÉS del error websocket de 13:03Z
  const ws = report.timeline.findIndex((e) => e.id === 'server:3');
  const dep = report.timeline.findIndex((e) => e.id === 'deploy:1');
  assert.ok(ws < dep);
});

test('clasifica eventos del servidor', () => {
  const evs = parseServerLog([
    "2026-09-29T13:05:18Z ERROR import Cannot find export 'normalizeCallIndex' module=call-index.js",
    '2026-09-29T13:06:00Z INFO health /health 200 proxy=cloudflare',
    '2026-09-29T13:09:42Z ERROR websocket seat=S003 unavailable',
  ].join('\n'));
  assert.deepEqual(evs.map((e) => e.type), ['code.missing_export', 'health.check', 'seat.ws_error']);
  assert.equal(evs[0].fields.symbol, 'normalizeCallIndex');
  assert.equal(evs[1].fields.viaProxy, 'cloudflare');
  assert.equal(evs[2].fields.seat, 'S003');
});

test('detecta exactamente los asientos caídos con dos señales independientes', () => {
  assert.deepEqual(report.impact.confirmed.seats, ['S003', 'S007', 'S014']);
  assert.deepEqual(report.impact.confirmed.activeCalls, []);
  assert.equal(report.seats.filter((s) => s.status === 'ok').length, 17);
});

test('NO culpa al error más ruidoso: el deploy es posterior a la caída de asientos', () => {
  const h1 = hyp('H1');
  assert.equal(h1.verdict, 'descartada');
  assert.match(h1.against[0].text, /110 s ANTES/);
});

test('el build candidato roto se confirma, pero la recuperación queda por verificar', () => {
  assert.match(hyp('H2').verdict, /sin verificar/);
  assert.ok(report.findings.verify.some((f) => /cloudflare/.test(f.text)));
});

test('descarta el build de cliente antiguo y no demuestra la relación con el carrier', () => {
  assert.equal(hyp('H5').verdict, 'descartada');
  assert.equal(hyp('H4').verdict, 'no demostrada');
});

test('estima llamadas activas en riesgo si el origen no está sano', () => {
  assert.deepEqual(report.impact.atRisk.activeCalls, ['S002', 'S005', 'S011']);
  assert.deepEqual(report.impact.external, [{ carrier: 'Beta', failed: 2, total: 3, users: 'desconocido' }]);
});

test('la recomendación es segura: congela despliegues antes de cualquier cambio', () => {
  const { next, doNot } = report.recommendation;
  assert.match(next.action, /Congelar despliegues/);
  assert.ok(doNot.some((d) => /ruidoso/.test(d)));
});

test('toda afirmación "known" o "inferred" sobre eventos cita referencias existentes', () => {
  const ids = new Set(report.timeline.map((e) => e.id));
  for (const f of [...report.findings.known, ...report.findings.inferred]) {
    for (const r of f.refs) assert.ok(ids.has(r), `referencia inexistente ${r} en: ${f.text}`);
  }
});

test('tolera fuentes ausentes y lo declara como brecha', () => {
  const partial = analyze({ serverLog: input.serverLog, heartbeats: input.heartbeats, seats: input.seats });
  assert.deepEqual(partial.meta.missing, ['deployLog', 'carrierLog']);
  assert.ok(partial.findings.verify.some((f) => /Fuentes ausentes/.test(f.text)));
  assert.equal(partial.hypotheses.find((h) => h.id === 'H1'), undefined);
});

test('si el deploy precede al corte, la hipótesis del deploy pasa a probable', () => {
  const shifted = { ...input, deployLog: input.deployLog.replace('08:04:50-05:00', '08:02:00-05:00') };
  assert.equal(analyze(shifted).hypotheses.find((h) => h.id === 'H1').verdict, 'probable');
});
