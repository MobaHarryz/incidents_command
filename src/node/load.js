// Carga las fuentes desde disco. Una fuente ausente no rompe el análisis:
// el motor la reporta como brecha de evidencia.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SOURCE_FILES = {
  serverLog: { file: 'server.log', json: false },
  deployLog: { file: 'deploy.log', json: false },
  carrierLog: { file: 'carrier.log', json: false },
  heartbeats: { file: 'client-heartbeats.json', json: true },
  seats: { file: 'seats.json', json: true },
};

export async function loadDir(dir) {
  const input = {};
  for (const [key, { file, json }] of Object.entries(SOURCE_FILES)) {
    try {
      const text = await readFile(join(dir, file), 'utf8');
      input[key] = json ? JSON.parse(text) : text;
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`${file}: ${err.message}`);
    }
  }
  return input;
}
