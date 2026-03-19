/**
 * Builder Bus Integration
 *
 * Enables the builder to communicate with other agents mid-build:
 * - Ask planner for clarification on ambiguous tasks
 * - Request tools from technician during a build
 * - Broadcast build progress for real-time monitoring
 */
import { BusClient, BusTopics } from 'kapow-shared';
import type { FileAttachment } from 'kapow-shared';

const busUrl = process.env.BUS_URL ?? 'http://localhost:3010';
const bus = new BusClient('builder', busUrl);

// Start polling for incoming messages (e.g. security stop signals)
bus.startPolling(3_000);

// Listen for security stop signals
let stopRequested = false;
bus.on(BusTopics.SECURITY_STOP, () => {
  console.warn('[builder] Security stop signal received — halting after current tool call');
  stopRequested = true;
});

export function isStopRequested(): boolean {
  return stopRequested;
}

export function resetStopFlag(): void {
  stopRequested = false;
}

/** Ask the planner to clarify an ambiguous task */
export async function askPlannerForClarification(
  taskDescription: string,
  question: string,
  runId: string,
): Promise<string> {
  try {
    const reply = await bus.request(
      BusTopics.CLARIFICATION_REQUEST,
      { taskDescription, question },
      'planner',
      30_000,
      runId,
    );
    return (reply.payload.answer as string) ?? 'No clarification available';
  } catch {
    return 'Planner unavailable for clarification — proceed with best judgment';
  }
}

/** Request a tool from the technician mid-build */
export async function requestToolFromTechnician(
  need: string,
  context: string,
  runId: string,
): Promise<{ toolName: string; available: boolean }> {
  try {
    const reply = await bus.request(
      BusTopics.TOOL_REQUEST,
      { need, context, requestingAgent: 'builder' },
      'technician',
      60_000, // Tool creation can take time
      runId,
    );
    return {
      toolName: (reply.payload.toolName as string) ?? '',
      available: (reply.payload.available as boolean) ?? false,
    };
  } catch {
    return { toolName: '', available: false };
  }
}

/** Broadcast build progress */
export async function broadcastBuildProgress(
  taskId: string,
  message: string,
  runId: string,
): Promise<void> {
  await bus.publish(BusTopics.BUILD_PROGRESS, { taskId, message }, { runId });
}

/** Share a file (screenshot, build output, etc.) with other agents */
export async function shareFile(
  name: string,
  content: Buffer,
  mimeType: string,
  runId: string,
): Promise<void> {
  const attachment = BusClient.createAttachment(name, content, mimeType);
  await bus.publish(BusTopics.FILE_SHARED, { name, mimeType }, {
    runId,
    attachments: [attachment],
  });
}

export { bus as builderBus };
