import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { LocationAgents } from '../src/location-agents.mjs';

// Launch this supervisor as a separate Windows process for independence from
// the chat and dashboard. It owns the verifier until completion and saves status.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const id = process.argv[2];
const limitArg = process.argv.slice(3).find(a => a.startsWith('--limit='));
const limit = Number(limitArg?.slice(8) || 10);
const agents = new LocationAgents({ root, database: path.resolve(process.env.DATABASE_PATH || path.join(root, 'data/hcrhub.sqlite')) });
const job = agents.startVerification(id, { limit, retryUnavailable: process.argv.includes('--retry-unavailable') });
console.log(JSON.stringify({ id, status: job.status, limit, workerPid: agents.get(id).pid, supervisorPid: process.pid }));
const child = agents.children.get(id);
if (child) await once(child, 'close');
const result = agents.publicJob(agents.get(id));
console.log(JSON.stringify(result));
if (result.status === 'failed') process.exitCode = 1;
