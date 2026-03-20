export class RunStoppedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStoppedError';
  }
}

interface RunControlState {
  abortController: AbortController;
  stopRequested: boolean;
  stopReason: string | null;
}

const controls = new Map<string, RunControlState>();

export function startRun(runId: string): AbortSignal {
  const state: RunControlState = {
    abortController: new AbortController(),
    stopRequested: false,
    stopReason: null,
  };
  controls.set(runId, state);
  return state.abortController.signal;
}

export function finishRun(runId: string): void {
  controls.delete(runId);
}

export function stopRun(runId: string, reason = 'Stopped by user.'): boolean {
  const state = controls.get(runId);
  if (!state) return false;

  state.stopRequested = true;
  state.stopReason = reason;
  state.abortController.abort(reason);
  return true;
}

export function isRunStopRequested(runId: string): boolean {
  return controls.get(runId)?.stopRequested ?? false;
}

export function getRunStopReason(runId: string): string {
  return controls.get(runId)?.stopReason ?? 'Stopped by user.';
}

export function assertRunActive(runId: string): void {
  if (isRunStopRequested(runId)) {
    throw new RunStoppedError(getRunStopReason(runId));
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.name === 'AbortError' || (err as Error & { code?: string }).code === 'ERR_CANCELED';
  }
  return false;
}
