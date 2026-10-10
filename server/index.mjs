import { createApplication } from './app.mjs';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const app = createApplication({ dataDir: process.env.DATA_DIR, additionalHost: process.env.ADDITIONAL_HOST || '' });
app.server.listen(port, host, () => {
  process.stdout.write(`KOVA Store listening on ${host}:${port}\n`);
});
