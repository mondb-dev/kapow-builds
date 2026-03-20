// PM2 ecosystem config — for running on a bare VM without Docker
// Usage: pm2 start ecosystem.config.cjs
// Requires: DATABASE_URL in .env or environment

const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kapow';
const HOST = process.env.HOST || '127.0.0.1';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.AUTH_SECRET || '';
const builderGeminiKey = process.env.BUILDER_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const builderAnthropicKey = process.env.BUILDER_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;
const technicianGeminiKey = process.env.TECHNICIAN_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
const technicianAnthropicKey = process.env.TECHNICIAN_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

module.exports = {
  apps: [
    {
      name: 'kapow-planner',
      cwd: path.join(root, 'planner'),
      script: 'dist/index.js',
      env: { PORT: 3001, HOST, SERVICE_NAME: 'planner', INTERNAL_API_KEY },
    },
    {
      name: 'kapow-builder',
      cwd: path.join(root, 'builder'),
      script: 'dist/index.js',
      env: {
        PORT: 3002,
        HOST,
        SERVICE_NAME: 'builder',
        INTERNAL_API_KEY,
        GEMINI_API_KEY: builderGeminiKey,
        ANTHROPIC_API_KEY: builderAnthropicKey,
      },
    },
    {
      name: 'kapow-qa',
      cwd: path.join(root, 'qa'),
      script: 'dist/index.js',
      env: { PORT: 3003, HOST, SERVICE_NAME: 'qa', INTERNAL_API_KEY },
    },
    {
      name: 'kapow-gate',
      cwd: path.join(root, 'gate'),
      script: 'dist/index.js',
      env: { PORT: 3004, HOST, SERVICE_NAME: 'gate', INTERNAL_API_KEY },
    },
    {
      name: 'kapow-technician',
      cwd: path.join(root, 'technician'),
      script: 'dist/index.js',
      env: {
        PORT: 3006,
        HOST,
        SERVICE_NAME: 'technician',
        INTERNAL_API_KEY,
        DATABASE_URL: DB_URL,
        GEMINI_API_KEY: technicianGeminiKey,
        ANTHROPIC_API_KEY: technicianAnthropicKey,
      },
    },
    {
      name: 'kapow-comms',
      cwd: path.join(root, 'comms'),
      script: 'dist/index.js',
      env: {
        PORT: 3008,
        HOST,
        SERVICE_NAME: 'comms',
        INTERNAL_API_KEY,
        COMMS_WEBHOOK_SECRET: process.env.COMMS_WEBHOOK_SECRET || INTERNAL_API_KEY,
        DATABASE_URL: DB_URL,
        ACTIONS_URL: 'http://localhost:3000',
        PLANNER_URL: 'http://localhost:3001',
      },
    },
    {
      name: 'kapow-security',
      cwd: path.join(root, 'security'),
      script: 'dist/index.js',
      env: {
        PORT: 3007,
        HOST,
        SERVICE_NAME: 'security',
        INTERNAL_API_KEY,
        DATABASE_URL: DB_URL,
        ACTIONS_URL: 'http://localhost:3000',
        PLANNER_URL: 'http://localhost:3001',
        BUILDER_URL: 'http://localhost:3002',
        QA_URL: 'http://localhost:3003',
        GATE_URL: 'http://localhost:3004',
        TECHNICIAN_URL: 'http://localhost:3006',
      },
    },
    {
      name: 'kapow-actions',
      cwd: path.join(root, 'actions'),
      script: 'dist/index.js',
      env: {
        PORT: 3000,
        HOST,
        SERVICE_NAME: 'actions',
        INTERNAL_API_KEY,
        DATABASE_URL: DB_URL,
        PLANNER_URL: 'http://localhost:3001',
        BUILDER_URL: 'http://localhost:3002',
        QA_URL: 'http://localhost:3003',
        GATE_URL: 'http://localhost:3004',
        TECHNICIAN_URL: 'http://localhost:3006',
        SECURITY_URL: 'http://localhost:3007',
      },
    },
    {
      name: 'kapow-board',
      cwd: path.join(root, 'board'),
      script: 'node_modules/.bin/next',
      args: `start -p 3005 -H ${HOST}`,
      env: {
        PORT: 3005,
        HOST,
        SERVICE_NAME: 'board',
        INTERNAL_API_KEY,
        DATABASE_URL: DB_URL,
        KAPOW_ACTIONS_URL: 'http://localhost:3000',
        PLANNER_URL: 'http://localhost:3001',
        SECURITY_URL: 'http://localhost:3007',
      },
    },
  ],
};
