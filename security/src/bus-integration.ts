/**
 * Security Bus Integration
 *
 * Enables security to:
 * - Listen for alerts from other agents (QA findings, etc.)
 * - Issue stop signals to halt builds
 * - Monitor all bus traffic for suspicious patterns
 */
import { BusClient, BusTopics } from 'kapow-shared';
import type { BusMessage } from 'kapow-shared';
import { createAlert } from './auditor.js';

const busUrl = process.env.BUS_URL ?? 'http://localhost:3010';
const bus = new BusClient('security', busUrl);

/** Start listening for security-relevant bus events */
export function startBusMonitoring(): void {
  // Listen for security alerts from other agents
  bus.on(BusTopics.SECURITY_ALERT, async (msg: BusMessage) => {
    const { finding, severity, file, source } = msg.payload as {
      finding: string; severity: string; file?: string; source: string;
    };

    await createAlert(
      source ?? msg.from,
      severity as 'info' | 'warning' | 'critical',
      'general',
      finding,
      file ? `File: ${file}` : 'No file reference',
      msg.runId,
    );
  });

  // Monitor all messages for suspicious patterns
  bus.on('*', async (msg: BusMessage) => {
    const content = JSON.stringify(msg.payload);

    // Check for secrets in bus traffic
    if (/(?:sk-|ghp_|xoxb-|AKIA)[a-zA-Z0-9]{10,}/.test(content)) {
      await createAlert(
        msg.from,
        'critical',
        'secret_exposure',
        'Potential secret detected in inter-agent bus traffic',
        `Topic: ${msg.topic}, from: ${msg.from}`,
        msg.runId,
      );
    }
  });

  bus.startPolling(2_000);
  console.log('[security] Bus monitoring started');
}

/** Issue a stop signal to halt the current build */
export async function issueStopSignal(runId: string, reason: string): Promise<void> {
  await bus.publish(BusTopics.SECURITY_STOP, { reason }, {
    runId,
    to: 'builder',
  });
  console.warn(`[security] Stop signal issued for run ${runId}: ${reason}`);
}

export { bus as securityBus };
