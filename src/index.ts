// src/index.ts
// CoopAtlas Ops — standalone entry (local dev / isolated hosting).
// In production the router is mounted into coopatlas-backend at /ops instead,
// so this file is only used for `npm run dev` / isolated testing.

import 'dotenv/config';
import express from 'express';
import { createOpsRouter } from './router';
import { config, logConfigSummary } from './config';

const port = Number.parseInt(process.env.PORT ?? '10001', 10);

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/ops', createOpsRouter({ startCron: true }));

app.listen(port, () => {
  logConfigSummary();
  console.log(`🚀 CoopAtlas Ops standalone listening on http://localhost:${port}/ops`);
});

export { config };
