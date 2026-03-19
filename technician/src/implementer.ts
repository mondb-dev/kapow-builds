import { getAI } from 'kapow-shared';
import { randomUUID } from 'crypto';
import type { BuildToolRequest, BuildToolResult, ToolDefinition } from './types.js';
import { upsertTool, updateToolStatus } from './registry.js';

const { provider, models } = getAI();

const SYSTEM_PROMPT = `You are the Implementer Agent — the second half of the Technician team.

Your job: Given a tool specification from the Research Agent, write the implementation code and a test.

You produce a JSON object with exactly these fields:
- implementation: string (a complete, self-contained TypeScript function body)
- testCode: string (a test that validates the tool works correctly)
- notes: string (any implementation decisions or caveats)

Implementation rules:
- The function receives parameters as a single object matching the spec's parameter list.
- Return type must match the spec's returnType.
- Use only Node.js built-ins and the dependencies listed in the spec.
- The implementation must be a COMPLETE function body (not a module — no imports at the top level). If you need imports, use dynamic import() inside the function.
- Handle errors gracefully — throw descriptive Error objects, never silently fail.
- No side effects outside the function's stated purpose.
- No hardcoded secrets, paths, or environment-specific values.

Test rules:
- The test is a self-contained async function that returns { passed: boolean, output: string }.
- It should exercise the happy path and at least one error case.
- It must not require external services (mock if needed).`;

export async function buildTool(request: BuildToolRequest): Promise<BuildToolResult> {
  const { runId, research } = request;
  const toolId = `tool-${research.toolName}-${randomUUID().slice(0, 8)}`;

  // Mark as building in registry
  const toolDraft: ToolDefinition = {
    id: toolId,
    name: research.toolName,
    description: research.description,
    version: 1,
    status: 'building',
    parameters: research.parameters,
    returnType: research.returnType,
    implementation: '',
    testCode: '',
    tags: [],
    doc: { summary: '', usage: '', parameters: '', returns: '', examples: [], caveats: [], relatedTools: [] },
    createdBy: runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  upsertTool(toolDraft);

  try {
    const response = await provider.chat({
      model: models.balanced,
      maxTokens: 8192,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Build this tool:\n\nName: ${research.toolName}\nDescription: ${research.description}\nParameters: ${JSON.stringify(research.parameters, null, 2)}\nReturn type: ${research.returnType}\nApproach: ${research.approach}\nDependencies: ${research.dependencies.join(', ') || 'none'}\n\nRespond with ONLY the JSON object.`,
        },
      ],
    });

    const text = response.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) ?? [null, text];
    const result = JSON.parse(jsonMatch[1]!.trim());

    // Update tool with implementation
    updateToolStatus(toolId, 'testing');
    const tool: ToolDefinition = {
      ...toolDraft,
      status: 'testing',
      implementation: result.implementation,
      testCode: result.testCode,
      tags: deriveTags(research),
      updatedAt: new Date().toISOString(),
    };
    upsertTool(tool);

    // Run the test
    const testOutput = await runToolTest(tool);

    if (testOutput.passed) {
      tool.status = 'ready';
      upsertTool(tool);
      return { runId, toolId, tool, success: true, testOutput: testOutput.output };
    } else {
      tool.status = 'failed';
      upsertTool(tool);
      return { runId, toolId, tool, success: false, testOutput: testOutput.output, error: 'Test failed' };
    }
  } catch (err: unknown) {
    updateToolStatus(toolId, 'failed');
    const msg = err instanceof Error ? err.message : String(err);
    return {
      runId,
      toolId,
      tool: { ...toolDraft, status: 'failed' },
      success: false,
      testOutput: '',
      error: msg,
    };
  }
}

async function runToolTest(tool: ToolDefinition): Promise<{ passed: boolean; output: string }> {
  try {
    // Create and execute the test function in an isolated scope
    const testFn = new Function('tool', `
      return (async () => {
        try {
          const impl = new Function('params', ${JSON.stringify(tool.implementation)});
          const testRunner = new Function('impl', ${JSON.stringify(tool.testCode)});
          return await testRunner(impl);
        } catch (err) {
          return { passed: false, output: 'Test execution error: ' + (err.message || String(err)) };
        }
      })();
    `);

    const result = await testFn(tool);
    return {
      passed: Boolean(result?.passed),
      output: String(result?.output ?? ''),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { passed: false, output: `Test runner error: ${msg}` };
  }
}

function deriveTags(research: BuildToolRequest['research']): string[] {
  const tags: string[] = [];
  const desc = research.description.toLowerCase();

  if (desc.includes('file') || desc.includes('read') || desc.includes('write')) tags.push('filesystem');
  if (desc.includes('http') || desc.includes('api') || desc.includes('fetch')) tags.push('network');
  if (desc.includes('parse') || desc.includes('transform') || desc.includes('convert')) tags.push('transform');
  if (desc.includes('git') || desc.includes('repo')) tags.push('git');
  if (desc.includes('test') || desc.includes('validate')) tags.push('validation');
  if (desc.includes('deploy') || desc.includes('build')) tags.push('devops');
  if (desc.includes('security') || desc.includes('auth') || desc.includes('secret')) tags.push('security');

  if (tags.length === 0) tags.push('general');
  return tags;
}
