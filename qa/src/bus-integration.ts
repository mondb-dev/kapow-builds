/**
 * QA Bus Integration
 *
 * Enables QA to:
 * - Send findings to security in real-time
 * - Broadcast QA progress
 * - Share evidence files (screenshots, test output)
 */
import { BusClient, BusTopics } from 'kapow-shared';

const busUrl = process.env.BUS_URL ?? 'http://localhost:3010';
const bus = new BusClient('qa', busUrl);

/** Send a security finding to the security agent */
export async function reportSecurityFinding(
  finding: string,
  severity: 'info' | 'warning' | 'critical',
  file: string | undefined,
  runId: string,
): Promise<void> {
  await bus.publish(BusTopics.SECURITY_ALERT, {
    finding,
    severity,
    file,
    source: 'qa',
  }, { runId });
}

/** Broadcast QA progress */
export async function broadcastQAProgress(
  taskId: string,
  message: string,
  runId: string,
): Promise<void> {
  await bus.publish(BusTopics.QA_FINDING, { taskId, message }, { runId });
}

/** Share evidence file */
export async function shareEvidence(
  name: string,
  content: Buffer,
  mimeType: string,
  runId: string,
): Promise<void> {
  const attachment = BusClient.createAttachment(name, content, mimeType);
  await bus.publish(BusTopics.FILE_SHARED, { name, mimeType, source: 'qa' }, {
    runId,
    attachments: [attachment],
  });
}

export { bus as qaBus };
