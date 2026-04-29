// PM2 ecosystem config — 3-service architecture
// Usage: pm2 start ecosystem.config.cjs

const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kapow';
const HOST = process.env.HOST || '127.0.0.1';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.AUTH_SECRET || '';

const e = process.env;

module.exports = {
  apps: [
    {
      name: 'kapow-pipeline',
      cwd: path.join(root, 'pipeline'),
      script: 'dist/index.js',
      env: {
        PORT: 3000,
        HOST,
        DATABASE_URL: DB_URL,
        INTERNAL_API_KEY,
        TECHNICIAN_URL: 'http://localhost:3006',
        // AI providers
        AI_PROVIDER: e.AI_PROVIDER,
        AI_MODEL_STRONG: e.AI_MODEL_STRONG,
        AI_MODEL_BALANCED: e.AI_MODEL_BALANCED,
        AI_MODEL_FAST: e.AI_MODEL_FAST,
        GEMINI_API_KEY: e.GEMINI_API_KEY,
        ANTHROPIC_API_KEY: e.ANTHROPIC_API_KEY,
        GOOGLE_CLOUD_PROJECT: e.GOOGLE_CLOUD_PROJECT,
        GOOGLE_CLOUD_LOCATION: e.GOOGLE_CLOUD_LOCATION,
        // Deploy
        GITHUB_TOKEN: e.GITHUB_TOKEN,
        VERCEL_TOKEN: e.VERCEL_TOKEN,
        VERCEL_SCOPE: e.VERCEL_SCOPE,
        NETLIFY_TOKEN: e.NETLIFY_TOKEN,
        GOOGLE_APPLICATION_CREDENTIALS: e.GOOGLE_APPLICATION_CREDENTIALS,
        // Comms
        COMMS_TELEGRAM_BOT_TOKEN: e.COMMS_TELEGRAM_BOT_TOKEN,
        COMMS_TELEGRAM_CHAT_ID: e.COMMS_TELEGRAM_CHAT_ID,
      },
    },
    {
      name: 'kapow-technician',
      cwd: path.join(root, 'technician'),
      script: 'dist/index.js',
      env: {
        PORT: 3006,
        HOST,
        DATABASE_URL: DB_URL,
        INTERNAL_API_KEY,
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
        DATABASE_URL: DB_URL,
        INTERNAL_API_KEY,
        KAPOW_ACTIONS_URL: 'http://localhost:3000',
      },
    },
  ],
};
