import express from 'express';
import { mountBusAPI } from './bus-api.js';

export function startBusServer(port: number): void {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // Large limit for file attachments
  const host = process.env.HOST ?? '127.0.0.1';

  mountBusAPI(app);

  app.listen(port, host, () => {
    process.stderr.write(`kapow-actions bus API listening on ${host}:${port}\n`);
  });
}
