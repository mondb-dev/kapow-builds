/**
 * Kapow Pipeline — Consolidated Service
 *
 * One process running: planner, builder, QA, gate.
 * No HTTP between agents — direct function calls.
 *
 * Exposes:
 * - HTTP API on PORT (default 3000) for board integration
 * - MCP server on stdio for Claude Desktop
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { runPipeline } from './orchestrator.js';
import { createHttpServer } from './http.js';
import { ensureRun, addRunLog } from 'kapow-db/runs';
import type { PipelineResult } from 'kapow-shared';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── MCP Server ───────────────────────────────────────────────────────

const server = new Server(
  { name: 'kapow-pipeline', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute_plan',
        description:
          'Execute a development plan through the Kapow pipeline: plan → build → QA → gate. ' +
          'Returns artifacts or diagnosis.',
        inputSchema: {
          type: 'object',
          properties: {
            plan: {
              type: 'string',
              description: 'The development plan or feature request to execute.',
            },
          },
          required: ['plan'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'execute_plan') {
    const plan = (args as { plan: string }).plan;
    if (!plan || typeof plan !== 'string') {
      return {
        content: [{ type: 'text', text: 'Error: plan must be a non-empty string.' }],
        isError: true,
      };
    }

    const runId = randomUUID();
    const messages: string[] = [];

    // Ensure run exists in DB
    await ensureRun(runId, plan).catch(() => {});

    const onProgress = (msg: string) => {
      messages.push(msg);
      process.stderr.write(msg + '\n');
      addRunLog(runId, 'pipeline', msg, 'info').catch(() => {});
    };

    onProgress(`[${runId}] Pipeline started.`);
    const result: PipelineResult = await runPipeline(runId, plan, onProgress);

    if (result.success) {
      const artifactSummary = (result.artifacts ?? [])
        .map((a) => `  - ${a.path} (${a.type})`)
        .join('\n');

      return {
        content: [{
          type: 'text',
          text: [
            `Run ID: ${runId}`,
            `Status: SUCCESS`,
            '',
            'Progress:',
            ...messages.map((m) => `  ${m}`),
            '',
            `Artifacts (${result.artifacts?.length ?? 0}):`,
            artifactSummary || '  (none)',
          ].join('\n'),
        }],
      };
    } else {
      return {
        content: [{
          type: 'text',
          text: [
            `Run ID: ${runId}`,
            `Status: FAILED`,
            '',
            'Progress:',
            ...messages.map((m) => `  ${m}`),
            '',
            `Diagnosis: ${result.diagnosis ?? 'Unknown error'}`,
          ].join('\n'),
        }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

// ── Start ────────────────────────────────────────────────────────────

async function main() {
  // Start HTTP server for board integration
  createHttpServer(PORT);

  // MCP server on stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('kapow-pipeline MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
