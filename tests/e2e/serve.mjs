// Tiny static server: node tests/e2e/serve.mjs [port]
import { startServer } from './server.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const port = Number(process.argv[2] || 8642);
const s = await startServer(root, { port });
console.log('Serving', root, 'at', s.url);
