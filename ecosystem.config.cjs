// PM2 ecosystem config — 3-service architecture
// Usage: pm2 start ecosystem.config.cjs

const path = require('path');
const root = __dirname;
require('dotenv').config({ path: path.join(root, '.env') });

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kapow';
const HOST = process.env.HOST || '127.0.0.1';
const INTERNAL_API_KEY = process.env.INTERNAL_API_KEY || process.env.AUTH_SECRET || '';

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
