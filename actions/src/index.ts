import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { runPipeline } from './orchestrator.js';
import { createHttpServer } from './http.js';

const server = new Server(
  { name: 'kapow-actions', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'execute_plan',
        description:
          'Execute a development plan through the full Kapow pipeline: plan → build → QA → gate. ' +
          'Returns a run ID with streaming progress, then final artifacts or diagnosis.',
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
      {
        name: 'pipeline_status',
        description: 'Check the current status of a running or completed pipeline by run ID.',
        inputSchema: {
          type: 'object',
          properties: {
            runId: {
              type: 'string',
              description: 'The run ID returned by execute_plan.',
            },
          },
          required: ['runId'],
        },
      },
    ],
  };
});

// In-memory run log (process-lifetime only)
const runLog = new Map<string, { status: string; messages: string[]; result?: unknown; createdAt: number }>();

// Cleanup entries older than 1 hour every 5 minutes
const RUN_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of runLog) {
    if (now - entry.createdAt > RUN_TTL_MS) runLog.delete(id);
  }
}, 5 * 60 * 1000);

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

    runLog.set(runId, { status: 'running', messages, createdAt: Date.now() });

    // Collect progress messages
    const onProgress = (msg: string) => {
      messages.push(msg);
      // Write to stderr so MCP host can surface them as notifications
      process.stderr.write(msg + '\n');
    };

    onProgress(`[${runId}] Pipeline started.`);

    // Run pipeline (async, but we await here — MCP tools are synchronous responses)
    const result = await runPipeline(runId, plan, onProgress);

    runLog.set(runId, { status: result.success ? 'done' : 'failed', messages, result, createdAt: Date.now() });

    if (result.success) {
      const artifactSummary = (result.artifacts ?? [])
        .map((a) => `  - ${a.path} (${a.type})`)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: [
              `Run ID: ${runId}`,
              `Status: SUCCESS`,
              '',
              'Progress log:',
              ...messages.map((m) => `  ${m}`),
              '',
              `Artifacts (${result.artifacts?.length ?? 0}):`,
              artifactSummary || '  (none)',
            ].join('\n'),
          },
        ],
      };
    } else {
      return {
        content: [
          {
            type: 'text',
            text: [
              `Run ID: ${runId}`,
              `Status: FAILED`,
              '',
              'Progress log:',
              ...messages.map((m) => `  ${m}`),
              '',
              `Diagnosis: ${result.diagnosis ?? 'Unknown error'}`,
            ].join('\n'),
          },
        ],
        isError: true,
      };
    }
  }

  if (name === 'pipeline_status') {
    const { runId } = args as { runId: string };
    const entry = runLog.get(runId);
    if (!entry) {
      return {
        content: [{ type: 'text', text: `No run found with ID: ${runId}` }],
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: [
            `Run ID: ${runId}`,
            `Status: ${entry.status}`,
            '',
            'Messages:',
            ...entry.messages.map((m) => `  ${m}`),
          ].join('\n'),
        },
      ],
    };
  }

  return {
    content: [{ type: 'text', text: `Unknown tool: ${name}` }],
    isError: true,
  };
});

async function main() {
  // Start HTTP server for kapow-board integration (port 3000)
  createHttpServer(3000);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('kapow-actions MCP server running on stdio\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
