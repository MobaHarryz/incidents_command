// Parsers: convierten cada fuente de observabilidad en eventos normalizados.
// Todas las marcas de tiempo se normalizan a UTC; se conserva la original
// porque las fuentes no comparten zona horaria (deploy.log usa -05:00).

const LINE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))\s+(.*)$/;
const KV_RE = /(\w+)=(\S+)/g;

/** @typedef {'info'|'warn'|'error'} Level */
/**
 * @typedef {Object} Event
 * @property {string} id          p.ej. "server:5"
 * @property {string} source      server | deploy | carrier | heartbeat
 * @property {number} ms          epoch ms (UTC)
 * @property {string} ts          ISO UTC
 * @property {string} rawTs       marca de tiempo tal como venía en la fuente
 * @property {string} tzOffset    "Z" o "-05:00"
 * @property {Level}  level
 * @property {string} type        tipo semántico (deploy.start, seat.ws_error, ...)
 * @property {string} message
 * @property {string} raw
 * @property {Object} fields
 */

export function parseTimestamp(raw) {
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new Error(`Marca de tiempo inválida: ${raw}`);
  const tzOffset = /Z$/i.test(raw) ? 'Z' : raw.slice(-6);
  return { ms, ts: new Date(ms).toISOString().replace('.000Z', 'Z'), rawTs: raw, tzOffset };
}

export function parseKv(text) {
  const out = {};
  for (const [, k, v] of text.matchAll(KV_RE)) out[k] = v;
  return out;
}

function splitLines(text, source, onLine, warnings) {
  const events = [];
  (text ?? '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    const m = LINE_RE.exec(line.trim());
    if (!m) {
      warnings.push(`${source}: línea ${i + 1} sin marca de tiempo reconocible, ignorada`);
      return;
    }
    const ev = onLine(m[2], parseTimestamp(m[1]));
    events.push({ id: `${source}:${i + 1}`, source, raw: line.trim(), ...parseTimestamp(m[1]), ...ev });
  });
  return events;
}

export function parseServerLog(text, warnings = []) {
  return splitLines(text, 'server', (rest) => {
    const [lvl, component = '', ...tail] = rest.split(/\s+/);
    const message = tail.join(' ');
    const fields = parseKv(message);
    const level = { INFO: 'info', WARN: 'warn', ERROR: 'error' }[lvl] ?? 'info';
    let type = `server.${component}`;

    if (component === 'boot') type = 'server.boot';
    else if (component === 'health') {
      const status = Number((/\b(\d{3})\b/.exec(message) ?? [])[1]);
      Object.assign(fields, { status, viaProxy: fields.proxy ?? null });
      type = 'health.check';
    } else if (component === 'import') {
      const sym = /Cannot find export '([^']+)'/.exec(message);
      if (sym) { fields.symbol = sym[1]; type = 'code.missing_export'; }
    } else if (component === 'systemd' && /restart/.test(message)) {
      fields.attempt = Number(fields.attempt);
      type = 'service.restart';
    } else if (component === 'websocket' && fields.seat) {
      type = 'seat.ws_error';
    }
    return { level, type, message: `${component} ${message}`.trim(), fields: { component, ...fields } };
  }, warnings);
}

export function parseDeployLog(text, warnings = []) {
  return splitLines(text, 'deploy', (rest) => {
    const fields = parseKv(rest);
    let type = 'deploy.other';
    let level = 'info';
    if (/^DEPLOY HALTED/.test(rest)) { type = 'deploy.halted'; level = 'error'; }
    else if (/^DEPLOY/.test(rest)) type = 'deploy.start';
    else if (/^PREFLIGHT/.test(rest)) { type = 'deploy.preflight'; fields.ok = /passed/.test(rest); }
    else if (/^HEALTHCHECK/.test(rest)) {
      type = 'deploy.healthcheck';
      fields.ok = !/failed/.test(rest);
      fields.service = rest.split(/\s+/)[2] ?? null;
      if (!fields.ok) level = 'error';
    } else if (/^NOTE/.test(rest)) type = 'deploy.note';
    return { level, type, message: rest, fields };
  }, warnings);
}

export function parseCarrierLog(text, warnings = []) {
  return splitLines(text, 'carrier', (rest) => {
    const fields = parseKv(rest);
    fields.status = Number(fields.status);
    const level = fields.status >= 400 ? 'error' : 'info';
    const type = fields.status === 401 || fields.status === 403 ? 'carrier.auth_error'
      : fields.status >= 400 ? 'carrier.error' : 'carrier.ok';
    return { level, type, message: rest, fields };
  }, warnings);
}

export function parseHeartbeats(list = []) {
  return list.map((hb, i) => ({
    id: `heartbeat:${hb.seat ?? i}`,
    source: 'heartbeat',
    ...parseTimestamp(hb.last_seen),
    level: 'info',
    type: 'heartbeat.last',
    message: `último heartbeat ${hb.seat} build=${hb.build}`,
    raw: JSON.stringify(hb),
    fields: { seat: hb.seat, build: hb.build },
  }));
}

/** Parsea todas las fuentes; tolera fuentes ausentes (se reportan como brechas). */
export function parseAll(input) {
  const warnings = [];
  const missing = [];
  for (const k of ['serverLog', 'deployLog', 'carrierLog', 'heartbeats', 'seats']) {
    if (input[k] == null) missing.push(k);
  }
  const events = [
    ...parseServerLog(input.serverLog, warnings),
    ...parseDeployLog(input.deployLog, warnings),
    ...parseCarrierLog(input.carrierLog, warnings),
    ...parseHeartbeats(input.heartbeats ?? []),
  ].sort((a, b) => a.ms - b.ms || a.id.localeCompare(b.id));
  return { events, seats: input.seats ?? [], heartbeats: input.heartbeats ?? [], warnings, missing };
}
