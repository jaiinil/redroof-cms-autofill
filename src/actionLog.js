import { appendFile, mkdir } from 'node:fs/promises';

const LOG_FILE = 'output/action-log.jsonl';

/**
 * Appends one production write action to a durable, append-only log.
 * Every create/update call should log through here so there is a complete
 * audit trail of what was changed, when, and with what result.
 */
export async function logAction(entry) {
  await mkdir('output', { recursive: true });
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  await appendFile(LOG_FILE, line + '\n');
}
