import Anthropic from '@anthropic-ai/sdk';
import type { ScanRequest, ScanResult, SecurityAlert } from './types.js';
import { createAlert } from './auditor.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the Security Scanner — an AI-powered security analysis agent for the Kapow development pipeline.

You analyze code artifacts, logs, and pipeline output for security vulnerabilities and policy violations.

Your analysis must return a JSON object with:
- alerts: array of { severity: "info"|"warning"|"critical", category: string, message: string, details: string }
- riskScore: number 0-100 (overall risk assessment)
- summary: string (brief human-readable summary)

Categories: secret_exposure, unauthorized_network, permission_escalation, suspicious_command, policy_violation, service_anomaly, general

Be precise. Do not flag safe patterns as risks. Focus on:
1. Hardcoded secrets, API keys, passwords, tokens
2. Command injection vectors (unsanitized input in shell commands)
3. Path traversal vulnerabilities
4. Insecure network calls (HTTP instead of HTTPS for sensitive data)
5. Missing input validation at system boundaries
6. Overly permissive file permissions
7. Dependencies with known vulnerabilities (if version info is present)
8. Logging of sensitive data

Do NOT flag:
- Environment variable reads (process.env.X) — that's the correct pattern
- Standard dev commands (npm install, git commit)
- Internal service-to-service HTTP (expected in Docker networks)`;

export async function scanContent(request: ScanRequest): Promise<ScanResult> {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Scan type: ${request.type}\nService: ${request.service ?? 'unknown'}\nRun ID: ${request.runId}\n\nContent to analyze:\n\`\`\`\n${request.content.slice(0, 50_000)}\n\`\`\`\n\nRespond with ONLY the JSON object.`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');

  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
  const result = JSON.parse(jsonMatch[1]!.trim());

  // Persist any alerts found
  const persistedAlerts: SecurityAlert[] = [];
  for (const alert of result.alerts ?? []) {
    const persisted = createAlert(
      request.service ?? 'scanner',
      alert.severity,
      alert.category,
      alert.message,
      alert.details,
      request.runId,
    );
    persistedAlerts.push(persisted);
  }

  return {
    runId: request.runId,
    alerts: persistedAlerts,
    riskScore: result.riskScore ?? 0,
    summary: result.summary ?? 'Scan complete.',
  };
}
