#!/usr/bin/env node
// Uso: node src/cli.js [directorio-de-datos] [--json]
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { analyze } from './engine/analyze.js';
import { loadDir } from './node/load.js';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--')) ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const report = analyze(await loadDir(dir));

if (args.includes('--json')) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.exit(0);
}

const c = process.stdout.isTTY
  ? { b: (s) => `\x1b[1m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m` }
  : { b: (s) => s, r: (s) => s, y: (s) => s, g: (s) => s, d: (s) => s };
const t = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
const refs = (r) => (r.length ? c.d(` [${r.join(' ')}]`) : '');
const out = [];

out.push(c.b(`\n■ CENTRO DE COMANDO DE INCIDENTES — ${report.severity}`));
out.push(report.headline, '');
out.push(c.b('Incidentes detectados'));
for (const i of report.incidents) out.push(`  ${c.r(i.severity)} ${i.title} ${c.d(`(${i.status}, desde ${t(i.startMs)})`)}\n      ${i.summary}`);

const im = report.impact;
out.push('', c.b('Impacto'));
out.push(`  Confirmado: ${im.confirmed.seats.length}/${im.confirmed.totalSeats} asientos (${im.confirmed.seats.join(', ') || '—'}), agencias: ${im.confirmed.agencies.join(', ') || '—'}, llamadas activas afectadas: ${im.confirmed.activeCalls.length}`);
if (im.atRisk) out.push(`  En riesgo:  ${im.atRisk.seats.length} asientos, llamadas activas ${im.atRisk.activeCalls.join(', ')}. ${c.d(im.atRisk.reason)}`);
for (const e of im.external) out.push(`  Externo:    carrier ${e.carrier} ${e.failed}/${e.total} fallidas, usuarios afectados: ${e.users}`);

for (const [key, label, color] of [['known', 'Lo que sabemos', c.g], ['inferred', 'Lo que inferimos', c.y], ['verify', 'Lo que falta verificar', c.r]]) {
  out.push('', c.b(label));
  for (const f of report.findings[key]) out.push(`  ${color('•')} ${f.text}${refs(f.refs)}`);
}

out.push('', c.b('Hipótesis'));
for (const h of report.hypotheses) {
  out.push(`  ${h.id} [${h.verdict}, ${Math.round(h.confidence * 100)}%] ${h.title}`);
  for (const f of h.for) out.push(`      + ${f.text}${refs(f.refs)}`);
  for (const f of h.against) out.push(`      − ${f.text}${refs(f.refs)}`);
}

const rec = report.recommendation;
out.push('', c.b('Siguiente paso seguro'));
rec.steps.forEach((s, i) => {
  out.push(`  ${i + 1}. ${s.action}\n     ${c.d('Por qué:')} ${s.why}\n     ${c.d('Riesgo:')} ${s.risk}`);
  if (s.branch) out.push(`     ${c.d('Según resultado:')} ${s.branch}`);
});
out.push('', c.b('Después de estabilizar'));
for (const l of rec.later) out.push(`  - ${l}`);
out.push('', c.b('No hacer'));
for (const d of rec.doNot) out.push(`  ✗ ${d}`);
out.push('');
process.stdout.write(out.join('\n') + '\n');
