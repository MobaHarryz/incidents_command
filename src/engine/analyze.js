// Motor de correlación. Cada afirmación que produce lleva:
//   kind: 'known'    → está literalmente en los datos (con referencia a eventos)
//         'inferred' → razonamiento sobre los datos (se explica por qué)
//         'verify'   → no se puede afirmar con estos datos; qué habría que comprobar
// Las reglas son genéricas (orden temporal, cohortes, señales cruzadas); ningún
// asiento, build o carrier está codificado a mano.

import { parseAll } from './parse.js';

export const DEFAULTS = {
  staleThresholdSec: 60,   // un asiento está "caído" si su último heartbeat es >60 s anterior al más reciente
  proximitySec: 120,       // ventana para marcar correlaciones temporales débiles
};

const hhmmss = (ms) => new Date(ms).toISOString().slice(11, 19) + 'Z';
const plural = (n, s, p = s + 's') => `${n} ${n === 1 ? s : p}`;
const list = (xs) => xs.join(', ');
const claim = (kind, text, refs = []) => ({ kind, text, refs });

// ---------------------------------------------------------------------------
// Detectores
// ---------------------------------------------------------------------------

export function analyzeHeartbeats(heartbeats, events, cfg) {
  if (!heartbeats.length) return null;
  const hbEvents = events.filter((e) => e.type === 'heartbeat.last');
  const snapshotMs = Math.max(...hbEvents.map((e) => e.ms));
  const stale = hbEvents.filter((e) => (snapshotMs - e.ms) / 1000 > cfg.staleThresholdSec);
  const healthy = hbEvents.filter((e) => !stale.includes(e));
  const onsetMs = stale.length ? Math.min(...stale.map((e) => e.ms)) : null;
  // Un único instante compartido de corte sugiere causa común.
  const sharedCutoff = stale.length > 1 && new Set(stale.map((e) => e.ms)).size === 1;
  return { snapshotMs, stale, healthy, onsetMs, sharedCutoff };
}

export function analyzeDeploy(events) {
  const starts = events.filter((e) => e.type === 'deploy.start');
  if (!starts.length) return null;
  const start = starts[starts.length - 1];
  const after = (t, from = start.ms) => events.filter((e) => e.type === t && e.ms >= from);
  const halted = after('deploy.halted')[0] ?? null;
  const healthcheck = after('deploy.healthcheck')[0] ?? null;
  const preflight = after('deploy.preflight')[0] ?? null;
  const notes = after('deploy.note');
  const missingExports = after('code.missing_export');
  const restarts = after('service.restart');
  const lastRestart = restarts[restarts.length - 1] ?? null;
  const bootsAfter = after('server.boot');
  const bootBefore = events.filter((e) => e.type === 'server.boot' && e.ms < start.ms).pop() ?? null;
  const pivot = lastRestart?.ms ?? halted?.ms ?? start.ms;
  const healthAfter = events.filter((e) => e.type === 'health.check' && e.ms > pivot);
  const directHealthAfter = healthAfter.filter((e) => !e.fields.viaProxy && e.fields.status === 200);
  // Si el proceso sigue escribiendo logs propios (no health vía proxy), algo está corriendo.
  const serverActivityAfter = events.filter((e) => e.source === 'server' && e.ms > pivot && e.type !== 'health.check');
  const symbols = missingExports.map((e) => e.fields.symbol);
  const fixNotes = notes.filter((n) => symbols.some((s) => n.message.includes(s)));
  return {
    start, build: start.fields.build, preflight, healthcheck, halted, notes, fixNotes,
    missingExports, restarts, lastRestart, bootsAfter, bootBefore, healthAfter, directHealthAfter,
    serverActivityAfter,
    recoveryConfirmed: bootsAfter.length > 0 && directHealthAfter.length > 0,
    windowEnd: Math.max(halted?.ms ?? start.ms, lastRestart?.ms ?? start.ms),
  };
}

export function analyzeCarriers(events) {
  const byCarrier = new Map();
  for (const e of events.filter((x) => x.source === 'carrier')) {
    const c = e.fields.carrier ?? 'desconocido';
    if (!byCarrier.has(c)) byCarrier.set(c, { carrier: c, total: 0, errors: [], ok: [] });
    const g = byCarrier.get(c);
    g.total += 1;
    (e.level === 'error' ? g.errors : g.ok).push(e);
  }
  const carriers = [...byCarrier.values()];
  for (const g of carriers) {
    const lastOk = g.ok[g.ok.length - 1];
    const lastErr = g.errors[g.errors.length - 1];
    g.degraded = g.errors.length > 0 && (!lastOk || lastErr.ms > lastOk.ms);
    g.authErrors = g.errors.filter((e) => e.type === 'carrier.auth_error');
    g.reasons = [...new Set(g.errors.map((e) => e.fields.message ?? `status ${e.fields.status}`))];
  }
  return carriers;
}

export function buildSeatStatus(seats, hb, events) {
  const wsBySeat = new Map();
  for (const e of events.filter((x) => x.type === 'seat.ws_error')) {
    if (!wsBySeat.has(e.fields.seat)) wsBySeat.set(e.fields.seat, []);
    wsBySeat.get(e.fields.seat).push(e);
  }
  const hbBySeat = new Map((hb ? [...hb.stale, ...hb.healthy] : []).map((e) => [e.fields.seat, e]));
  const staleIds = new Set((hb?.stale ?? []).map((e) => e.fields.seat));
  const ids = [...new Set([...seats.map((s) => s.seat), ...hbBySeat.keys()])].sort();
  return ids.map((id) => {
    const inv = seats.find((s) => s.seat === id) ?? {};
    const beat = hbBySeat.get(id);
    const ws = wsBySeat.get(id) ?? [];
    const stale = staleIds.has(id);
    // Dos señales independientes (cliente dejó de latir + servidor no lo alcanza) ⇒ caído.
    const status = !beat ? 'unknown' : stale && ws.length ? 'down' : stale || ws.length ? 'suspect' : 'ok';
    return {
      seat: id,
      agency: inv.agency ?? null,
      activeCall: inv.active_call ?? null,
      build: beat?.fields.build ?? null,
      lastSeen: beat?.ts ?? null,
      lastSeenMs: beat?.ms ?? null,
      status,
      refs: [beat?.id, ...ws.map((e) => e.id)].filter(Boolean),
    };
  });
}

/** Atributos que comparten TODOS los asientos afectados y que NO comparten todos los sanos. */
export function discriminatingAttributes(affected, healthy) {
  const out = [];
  for (const attr of ['agency', 'build', 'activeCall']) {
    const vals = new Set(affected.map((s) => s[attr]));
    if (vals.size !== 1) { out.push({ attr, discriminates: false, values: [...vals] }); continue; }
    const [v] = vals;
    const healthyWithSame = healthy.filter((s) => s[attr] === v).length;
    out.push({ attr, value: v, values: [v], discriminates: healthyWithSame === 0, healthyWithSame });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------------

export function analyze(input, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const { events, seats, heartbeats, warnings, missing } = parseAll(input);
  const logEndMs = Math.max(...events.map((e) => e.ms));
  const logStartMs = Math.min(...events.map((e) => e.ms));

  const hb = analyzeHeartbeats(heartbeats, events, cfg);
  const deploy = analyzeDeploy(events);
  const carriers = analyzeCarriers(events);
  const seatStatus = buildSeatStatus(seats, hb, events);

  const down = seatStatus.filter((s) => s.status === 'down');
  const suspect = seatStatus.filter((s) => s.status === 'suspect');
  const affected = [...down, ...suspect];
  const okSeats = seatStatus.filter((s) => s.status === 'ok');
  const activeCallSeats = seatStatus.filter((s) => s.activeCall);
  const degradedCarriers = carriers.filter((c) => c.degraded);
  const healthyCarriers = carriers.filter((c) => !c.degraded);
  const serverBuild = deploy?.bootBefore?.fields.build
    ?? events.filter((e) => e.type === 'server.boot').pop()?.fields.build ?? null;

  const builds = {};
  for (const s of seatStatus.filter((x) => x.build)) (builds[s.build] ??= []).push(s);

  const known = [];
  const inferred = [];
  const verify = [];
  const hypotheses = [];
  const incidents = [];

  // --- Zonas horarias -------------------------------------------------------
  const offsets = [...new Set(events.map((e) => e.tzOffset))];
  if (offsets.length > 1) {
    const odd = events.filter((e) => e.tzOffset !== 'Z');
    const ex = odd[0];
    known.push(claim('known',
      `Las fuentes mezclan zonas horarias (${list(offsets)}). Todo se normalizó a UTC: p.ej. ${ex.rawTs} = ${hhmmss(ex.ms)}.`,
      [ex.id]));
  }

  // --- Asientos -------------------------------------------------------------
  if (hb) {
    if (down.length || suspect.length) {
      known.push(claim('known',
        `${plural(hb.stale.length, 'asiento')} (${list(hb.stale.map((e) => e.fields.seat))}) dejaron de enviar heartbeats a las ${hhmmss(hb.onsetMs)}; los otros ${hb.healthy.length} reportaron hasta ${hhmmss(hb.snapshotMs)}.`,
        hb.stale.map((e) => e.id)));
      const wsRefs = affected.flatMap((s) => s.refs.filter((r) => r.startsWith('server:')));
      if (wsRefs.length) {
        known.push(claim('known',
          `El servidor registró errores websocket para ${list(affected.filter((s) => s.refs.some((r) => r.startsWith('server:'))).map((s) => s.seat))}: dos señales independientes (cliente y servidor) coinciden.`,
          wsRefs));
      }
      const agencies = [...new Set(affected.map((s) => s.agency))];
      const activeAffected = affected.filter((s) => s.activeCall);
      known.push(claim('known',
        `Asientos afectados por agencia: ${agencies.map((a) => `${a} (${affected.filter((s) => s.agency === a).length})`).join(', ')}. Con llamada activa: ${activeAffected.length ? list(activeAffected.map((s) => s.seat)) : 'ninguno'}.`,
        []));
      if (hb.sharedCutoff) {
        inferred.push(claim('inferred',
          `Los ${hb.stale.length} asientos se cortaron en el mismo instante (${hhmmss(hb.onsetMs)}): apunta a una causa común, no a fallos individuales al azar.`,
          hb.stale.map((e) => e.id)));
      }
      const attrs = discriminatingAttributes(affected, okSeats);
      const shared = attrs.filter((a) => a.discriminates);
      inferred.push(claim('inferred', shared.length
        ? `Atributo común exclusivo de los afectados: ${shared.map((a) => `${a.attr}=${a.value}`).join(', ')}.`
        : `Ningún atributo disponible explica el corte: ${attrs.map((a) => a.values.length > 1
          ? `${a.attr} mixto (${list(a.values.map(String))})`
          : `${a.attr}=${a.value} también en ${a.healthyWithSame} asientos sanos`).join('; ')}.`));
      verify.push(claim('verify',
        `Causa de la desconexión de ${list(affected.map((s) => s.seat))}: faltan logs de cliente/red (ISP, VPN, proxy de la agencia, suspensión del equipo).`,
        affected.flatMap((s) => s.refs)));
    }
    const silentSec = Math.round((logEndMs - hb.snapshotMs) / 1000);
    if (silentSec > cfg.staleThresholdSec) {
      verify.push(claim('verify',
        `Hora de captura de client-heartbeats.json: ningún heartbeat es posterior a ${hhmmss(hb.snapshotMs)}, pero los logs llegan hasta ${hhmmss(logEndMs)} (${silentSec} s después). ¿Es una foto tomada ~${hhmmss(hb.snapshotMs)} o toda la flota dejó de reportar?`,
        []));
    }
  }

  if (seats.length) {
    verify.push(claim('verify',
      'seats.json no tiene marca de tiempo: el estado active_call puede no ser el actual.', []));
  }

  // --- Deploy ---------------------------------------------------------------
  if (deploy) {
    const d = deploy;
    known.push(claim('known',
      `Deploy del build ${d.build} inició ${hhmmss(d.start.ms)}` +
      (d.preflight ? `, preflight ${d.preflight.fields.ok ? 'OK' : 'falló'}` : '') +
      (d.healthcheck ? `, healthcheck de ${d.healthcheck.fields.service} ${d.healthcheck.fields.ok ? 'OK' : 'falló'} ${hhmmss(d.healthcheck.ms)}` : '') +
      (d.halted ? `, deploy detenido ${hhmmss(d.halted.ms)}.` : '.'),
      [d.start, d.preflight, d.healthcheck, d.halted].filter(Boolean).map((e) => e.id)));
    if (d.missingExports.length) {
      const me = d.missingExports[0];
      known.push(claim('known',
        `Error de import en ${hhmmss(me.ms)}: falta el export '${me.fields.symbol}' en ${me.fields.module}` +
        (d.restarts.length ? `, seguido de ${plural(d.restarts.length, 'reinicio')} de systemd (${hhmmss(d.restarts[0].ms)}–${hhmmss(d.lastRestart.ms)}).` : '.'),
        [me.id, ...d.restarts.map((e) => e.id)]));
    }
    if (d.bootBefore) {
      known.push(claim('known',
        `Último arranque registrado del servidor: build ${d.bootBefore.fields.build} (${hhmmss(d.bootBefore.ms)}). No hay arranque ni rollback registrado después del deploy.`,
        [d.bootBefore.id]));
    }
    if (d.preflight?.fields.ok && d.missingExports.length) {
      inferred.push(claim('inferred',
        `El build ${d.build} está roto y el preflight no lo detectó: el pipeline no valida imports/exports antes del healthcheck.`,
        [d.preflight.id, d.missingExports[0].id]));
    }
    if (d.halted && !d.recoveryConfirmed) {
      inferred.push(claim('inferred',
        `Al detenerse el deploy, lo más probable es que siga corriendo ${d.bootBefore?.fields.build ?? 'el build anterior'}, pero no hay evidencia de rollback.`,
        [d.halted.id]));
      verify.push(claim('verify',
        'Qué build corre ahora en live-call-server y si el proceso quedó estable tras los reinicios.',
        d.restarts.map((e) => e.id)));
    }
    if (d.serverActivityAfter.length) {
      const a = d.serverActivityAfter[0];
      inferred.push(claim('inferred',
        `El proceso del servidor sigue vivo después de los reinicios: escribe eventos propios a las ${hhmmss(a.ms)}. Eso contradice una caída total.`,
        d.serverActivityAfter.map((e) => e.id)));
    }
    for (const h of d.healthAfter.filter((e) => e.fields.viaProxy)) {
      verify.push(claim('verify',
        `El /health ${h.fields.status} de ${hhmmss(h.ms)} pasó por ${h.fields.viaProxy}: puede venir de caché o del edge. No prueba que el origen esté sano; comprobarlo sin pasar por el proxy.`,
        [h.id]));
    }
    for (const n of d.fixNotes) {
      inferred.push(claim('inferred',
        `Ya hay un fix-forward preparado ("${n.message.replace(/^NOTE\s+/, '')}"), pero no hay evidencia de que se haya probado.`,
        [n.id]));
    }
    if (d.restarts.length && activeCallSeats.length) {
      verify.push(claim('verify',
        `Si las llamadas activas (${list(activeCallSeats.map((s) => s.seat))}) sobrevivieron a los reinicios de ${hhmmss(d.restarts[0].ms)}–${hhmmss(d.lastRestart.ms)}.`,
        d.restarts.map((e) => e.id)));
    }
  }

  // --- Carriers ---------------------------------------------------------------
  for (const c of degradedCarriers) {
    known.push(claim('known',
      `Carrier ${c.carrier}: ${c.errors.length}/${c.total} peticiones fallidas (${list(c.reasons)})` +
      (healthyCarriers.length ? `; ${list(healthyCarriers.map((h) => `${h.carrier} ${h.ok.length}/${h.total} OK`))}.` : '.'),
      c.errors.map((e) => e.id)));
    const loginOk = c.ok.find((e) => /login/.test(e.fields.action ?? ''));
    inferred.push(claim('inferred',
      `El problema de ${c.carrier} está aislado a ese proveedor` +
      (loginOk && c.authErrors.length ? ': la sesión expira justo después de un login exitoso, lo que apunta a credenciales o sesión del lado del carrier, no a nuestra plataforma.' : '.'),
      [loginOk?.id, ...c.errors.map((e) => e.id)].filter(Boolean)));
    verify.push(claim('verify',
      `Qué usuarios o flujos cotizan con ${c.carrier}: el impacto en cotizaciones no se puede cuantificar con estos datos.`, []));
  }

  // --- Builds de cliente ------------------------------------------------------
  const buildNames = Object.keys(builds).sort();
  if (buildNames.length > 1) {
    const minority = buildNames.filter((b) => b !== serverBuild);
    for (const b of minority) {
      const seatsB = builds[b];
      known.push(claim('known',
        `${plural(seatsB.length, 'asiento')} (${list(seatsB.map((s) => s.seat))}) usan el build de cliente ${b}; el servidor corre ${serverBuild}. ` +
        `${seatsB.filter((s) => s.status === 'ok').length}/${seatsB.length} reportan con normalidad.`,
        seatsB.flatMap((s) => s.refs)));
    }
    if (deploy?.fixNotes.length) {
      verify.push(claim('verify',
        `Compatibilidad del patch (${deploy.fixNotes[0].message.replace(/^NOTE\s+/, '')}) con clientes en ${list(minority)}.`,
        [deploy.fixNotes[0].id]));
    }
  }

  if (missing.length) {
    verify.push(claim('verify', `Fuentes ausentes en este análisis: ${list(missing)}. Las conclusiones que dependen de ellas no se evaluaron.`));
  }

  // --- Hipótesis ----------------------------------------------------------------
  if (deploy && hb?.onsetMs != null) {
    const delta = Math.round((deploy.start.ms - hb.onsetMs) / 1000);
    const before = delta > 0;
    const firstWs = events.find((e) => e.type === 'seat.ws_error' && affected.some((s) => s.seat === e.fields.seat));
    hypotheses.push({
      id: 'H1',
      title: `El deploy ${deploy.build} causó la desconexión de asientos`,
      verdict: before ? 'descartada' : 'probable',
      confidence: before ? 0.05 : 0.6,
      for: [
        claim('known', `Las dos cosas pasan en los mismos 10 minutos y afectan a live-call-server.`, [deploy.start.id]),
        claim('known', `Es el error más ruidoso: import fallido + ${plural(deploy.restarts.length, 'reinicio')}.`, deploy.restarts.map((e) => e.id)),
      ],
      against: before ? [
        claim('known', `Los asientos dejaron de reportar a las ${hhmmss(hb.onsetMs)}, ${delta} s ANTES de que empezara el deploy (${hhmmss(deploy.start.ms)}).`,
          [...hb.stale.map((e) => e.id), deploy.start.id]),
        ...(firstWs && firstWs.ms < deploy.start.ms
          ? [claim('known', `El primer error websocket (${firstWs.fields.seat}, ${hhmmss(firstWs.ms)}) también es anterior al deploy.`, [firstWs.id])]
          : []),
      ] : [],
    });
  }

  if (deploy?.missingExports.length) {
    hypotheses.push({
      id: 'H2',
      title: `El build candidato ${deploy.build} rompe live-call-server (falta el export '${deploy.missingExports[0].fields.symbol}')`,
      verdict: deploy.recoveryConfirmed ? 'confirmada (resuelta)' : 'confirmada (contenida, sin verificar)',
      confidence: 0.9,
      for: [
        claim('known', `Error de import explícito en ${hhmmss(deploy.missingExports[0].ms)}.`, [deploy.missingExports[0].id]),
        ...(deploy.healthcheck && !deploy.healthcheck.fields.ok ? [claim('known', 'Healthcheck del deploy falló y el deploy se detuvo.', [deploy.healthcheck.id, deploy.halted?.id].filter(Boolean))] : []),
        ...deploy.fixNotes.map((n) => claim('known', 'La nota del deploy reconoce el export faltante.', [n.id])),
      ],
      against: [
        ...(deploy.halted ? [claim('inferred', 'El deploy se detuvo: el daño debería estar contenido al candidato.', [deploy.halted.id])] : []),
        ...(deploy.serverActivityAfter.length ? [claim('inferred', 'El servidor sigue registrando eventos tras los reinicios.', deploy.serverActivityAfter.map((e) => e.id))] : []),
      ],
    });
  }

  if (affected.length) {
    const attrs = discriminatingAttributes(affected, okSeats);
    const agencies = new Set(affected.map((s) => s.agency));
    hypotheses.push({
      id: 'H3',
      title: `Pérdida de conectividad localizada en ${list(affected.map((s) => s.seat))} (cliente/red), independiente del deploy`,
      verdict: 'más probable (causa exacta sin identificar)',
      confidence: 0.6,
      for: [
        ...(hb.sharedCutoff ? [claim('known', `Corte simultáneo a las ${hhmmss(hb.onsetMs)}.`, hb.stale.map((e) => e.id))] : []),
        claim('known', 'El servidor confirma que no puede alcanzarlos (errores websocket), incluso minutos después.', affected.flatMap((s) => s.refs.filter((r) => r.startsWith('server:')))),
        claim('known', `El resto de asientos de las mismas agencias sigue reportando (${okSeats.length}/${seatStatus.length}).`),
      ],
      against: [
        claim('verify', 'No hay logs de cliente ni de red para confirmar el mecanismo.'),
        ...(agencies.size > 1 ? [claim('inferred', `Afecta a ${agencies.size} agencias distintas, así que no es un corte de red de una sola agencia (salvo que compartan proveedor).`)] : []),
        ...(attrs.every((a) => !a.discriminates) ? [claim('inferred', 'Ningún atributo de los datos separa a los afectados de los sanos.')] : []),
      ],
    });
  }

  for (const c of degradedCarriers) {
    if (hb?.onsetMs == null) break;
    const lastErr = c.errors[c.errors.length - 1];
    const delta = Math.round((hb.onsetMs - lastErr.ms) / 1000);
    hypotheses.push({
      id: `H4-${c.carrier}`,
      title: `La falla de autenticación con el carrier ${c.carrier} está relacionada con la desconexión de asientos`,
      verdict: 'no demostrada',
      confidence: Math.abs(delta) <= cfg.proximitySec ? 0.15 : 0.05,
      for: Math.abs(delta) <= cfg.proximitySec
        ? [claim('known', `Proximidad temporal: el último error de ${c.carrier} fue ${Math.abs(delta)} s antes del corte de asientos.`, [lastErr.id])]
        : [],
      against: [
        claim('verify', `No hay ningún dato que vincule asientos con el carrier ${c.carrier}: la coincidencia temporal no demuestra causa.`),
        ...(healthyCarriers.length ? [claim('known', `${list(healthyCarriers.map((h) => h.carrier))} sigue funcionando: es una falla del proveedor, no de la plataforma.`, healthyCarriers.flatMap((h) => h.ok.map((e) => e.id)))] : []),
      ],
    });
  }

  for (const b of buildNames.filter((x) => x !== serverBuild)) {
    const seatsB = builds[b];
    const okB = seatsB.filter((s) => s.status === 'ok').length;
    hypotheses.push({
      id: `H5-${b}`,
      title: `Los clientes con el build antiguo ${b} causan fallas`,
      verdict: okB === seatsB.length ? 'descartada' : 'posible',
      confidence: okB === seatsB.length ? 0.05 : 0.4,
      for: [claim('known', `Hay desfase de versiones entre clientes (${list(buildNames)}).`)],
      against: okB === seatsB.length
        ? [claim('known', `Los ${seatsB.length} asientos con ${b} están sanos; los afectados usan otro build.`, seatsB.flatMap((s) => s.refs))]
        : [],
    });
  }

  // --- Incidentes detectados ---------------------------------------------------
  if (affected.length) {
    const lastWs = events.filter((e) => e.type === 'seat.ws_error' && affected.some((s) => s.seat === e.fields.seat)).pop();
    incidents.push({
      id: 'INC-1',
      title: `Desconexión de ${plural(affected.length, 'asiento')} (${list(affected.map((s) => s.seat))})`,
      severity: affected.some((s) => s.activeCall) ? 'SEV-1' : 'SEV-2',
      status: 'activo',
      userFacing: true,
      startMs: hb.onsetMs,
      lastEvidenceMs: lastWs?.ms ?? hb.onsetMs,
      summary: `Los agentes afectados no pueden recibir llamadas desde ${hhmmss(hb.onsetMs)}. Sigue ocurriendo: la última evidencia es de ${hhmmss(lastWs?.ms ?? hb.onsetMs)}.`,
      refs: affected.flatMap((s) => s.refs),
    });
  }
  if (deploy && (deploy.halted || deploy.missingExports.length)) {
    incidents.push({
      id: 'INC-2',
      title: `Deploy fallido ${deploy.build} en ${deploy.healthcheck?.fields.service ?? 'servidor'}`,
      severity: deploy.recoveryConfirmed ? 'SEV-4' : 'SEV-3',
      status: deploy.recoveryConfirmed ? 'resuelto' : 'contenido, sin verificar',
      userFacing: false,
      startMs: deploy.start.ms,
      lastEvidenceMs: deploy.windowEnd,
      summary: `El candidato no arranca porque le falta un export. El deploy se detuvo, pero hubo ${plural(deploy.restarts.length, 'reinicio')} y la recuperación solo se ha visto a través del proxy.`,
      refs: [deploy.start, deploy.halted, ...deploy.missingExports, ...deploy.restarts].filter(Boolean).map((e) => e.id),
    });
  }
  for (const c of degradedCarriers) {
    incidents.push({
      id: `INC-3-${c.carrier}`,
      title: `Autenticación fallida con el carrier ${c.carrier}`,
      severity: 'SEV-3',
      status: 'externo, activo',
      userFacing: true,
      startMs: c.errors[0].ms,
      lastEvidenceMs: c.errors[c.errors.length - 1].ms,
      summary: `Las cotizaciones con ${c.carrier} fallan (${list(c.reasons)}); los demás carriers responden bien.`,
      refs: c.errors.map((e) => e.id),
    });
  }
  incidents.sort((a, b) => a.severity.localeCompare(b.severity) || a.startMs - b.startMs);

  // --- Impacto -----------------------------------------------------------------
  const recoveryUnverified = deploy && deploy.restarts.length > 0 && !deploy.recoveryConfirmed;
  const impact = {
    confirmed: {
      seats: down.map((s) => s.seat),
      suspect: suspect.map((s) => s.seat),
      agencies: [...new Set(affected.map((s) => s.agency))],
      activeCalls: affected.filter((s) => s.activeCall).map((s) => s.seat),
      totalSeats: seatStatus.length,
    },
    atRisk: recoveryUnverified ? {
      reason: 'Si el origen de live-call-server no está sano (recuperación sin verificar), todos los asientos conectados están expuestos.',
      seats: seatStatus.filter((s) => s.status === 'ok').map((s) => s.seat),
      activeCalls: activeCallSeats.filter((s) => s.status === 'ok').map((s) => s.seat),
    } : null,
    external: degradedCarriers.map((c) => ({ carrier: c.carrier, failed: c.errors.length, total: c.total, users: 'desconocido' })),
  };

  // --- Siguiente paso seguro ---------------------------------------------------------
  const activeNow = activeCallSeats.map((s) => s.seat);
  const steps = [];
  if (deploy) {
    steps.push({
      action: 'Congelar despliegues. No aplicar ahora el patch de fix-forward.',
      why: `${activeNow.length ? `Hay ${plural(activeNow.length, 'llamada activa', 'llamadas activas')} (${list(activeNow)}) y` : 'Además,'} desplegar reinicia live-call-server. El patch tampoco arregla la desconexión de asientos, que empezó antes del deploy.`,
      risk: 'ninguno',
    });
    steps.push({
      action: 'Comprobar el origen directamente, sin pasar por el proxy (solo lectura): /health contra el origen, `systemctl status live-call-server` y qué build está en ejecución.',
      why: 'Es la mayor incógnita: la recuperación solo se ha visto a través de Cloudflare.',
      risk: 'ninguno (solo lectura)',
      branch: `Si el origen responde con ${deploy.bootBefore?.fields.build ?? 'el build anterior'}, no hay que hacer nada más con el deploy. Si corre ${deploy.build} o no responde, hacer rollback a ${deploy.bootBefore?.fields.build ?? 'el último build estable'}, preferiblemente cuando no haya llamadas activas en ese nodo.`,
    });
  }
  if (affected.length) {
    const noCalls = affected.every((s) => !s.activeCall);
    steps.push({
      action: `Contactar a los agentes de ${list(affected.map((s) => s.seat))}: pedirles que recarguen el cliente, revisar su red y recoger los logs del cliente.`,
      why: 'Es el incidente real con impacto en usuarios y su causa no está en los logs del servidor.',
      risk: noCalls ? 'ninguno: no tienen llamadas activas' : 'moderado: hay llamadas activas',
    });
  }
  for (const c of degradedCarriers) {
    steps.push({
      action: `Abrir un caso con el carrier ${c.carrier} y revisar sus credenciales o la vigencia de la sesión.${healthyCarriers.length ? ` Si el negocio lo permite, cotizar con ${list(healthyCarriers.map((h) => h.carrier))} mientras tanto.` : ''}`,
      why: 'Es una falla externa aislada; no conviene mezclarla con la respuesta al incidente de asientos.',
      risk: 'bajo',
    });
  }
  const later = [];
  if (deploy?.preflight?.fields.ok && deploy.missingExports.length) {
    later.push('Añadir al preflight una verificación de imports/exports (p.ej. arrancar el módulo o `node --check` más un smoke import). El preflight aprobó un build que no arranca.');
  }
  if (deploy?.fixNotes.length) {
    later.push(`Desplegar el patch como canary, en una ventana sin llamadas activas y probándolo con clientes en ${list(buildNames.filter((b) => b !== serverBuild)) || 'todos los builds'}.`);
  }
  later.push('Hacer que el healthcheck post-deploy consulte el origen y no el proxy/CDN.');

  const doNot = [
    'No tomar el error más ruidoso (import + reinicios) como causa de la caída de asientos: el orden temporal lo descarta.',
    'No considerar el /health vía proxy como prueba de recuperación.',
    ...(activeNow.length ? ['No reiniciar live-call-server mientras haya llamadas activas, salvo que el origen esté realmente caído.'] : []),
  ];

  const severity = incidents[0]?.severity ?? 'SEV-4';
  const headline = affected.length
    ? `${plural(affected.length, 'asiento')} desconectados desde ${hhmmss(hb.onsetMs)} por una causa aún sin identificar, anterior al deploy fallido de ${deploy ? hhmmss(deploy.start.ms) : '—'}. El deploy quedó contenido, pero su recuperación no está verificada.`
    : 'No se detectan asientos afectados.';

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      logStart: new Date(logStartMs).toISOString(),
      logEnd: new Date(logEndMs).toISOString(),
      heartbeatSnapshot: hb ? new Date(hb.snapshotMs).toISOString() : null,
      serverBuild,
      config: cfg,
      warnings,
      missing,
    },
    severity,
    headline,
    incidents,
    impact,
    findings: { known, inferred, verify },
    hypotheses,
    recommendation: { next: steps[0] ?? null, steps, later, doNot },
    seats: seatStatus,
    carriers: carriers.map(({ carrier, total, errors, degraded, reasons }) => ({ carrier, total, failed: errors.length, degraded, reasons })),
    timeline: events,
    markers: {
      deployWindow: deploy ? { start: deploy.start.ms, end: deploy.windowEnd, build: deploy.build } : null,
      seatOutageOnset: hb?.onsetMs ?? null,
    },
  };
}
