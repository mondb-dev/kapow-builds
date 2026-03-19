import express from 'express';
import { mountBusAPI } from './bus-api.js';

export function startBusServer(port: number): void {
  const app = express();
  app.use(express.json({ limit: '50mb' })); // Large limit for file attachments

  mountBusAPI(app);

  app.listen(port, () => {
    process.stderr.write(`kapow-actions bus API listening on port ${port}\n`);
  });
}
