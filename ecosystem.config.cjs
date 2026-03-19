// PM2 ecosystem config — for running on a bare VM without Docker
// Usage: pm2 start ecosystem.config.cjs
// Requires: DATABASE_URL in .env or environment

const path = require('path');
const root = __dirname;

const DB_URL = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/kapow';

module.exports = {
  apps: [
    {
      name: 'kapow-planner',
      cwd: path.join(root, 'planner'),
      script: 'dist/index.js',
      env: { PORT: 3001 },
    },
    {
      name: 'kapow-builder',
      cwd: path.join(root, 'builder'),
      script: 'dist/index.js',
      env: { PORT: 3002 },
    },
    {
      name: 'kapow-qa',
      cwd: path.join(root, 'qa'),
      script: 'dist/index.js',
      env: { PORT: 3003 },
    },
    {
      name: 'kapow-gate',
      cwd: path.join(root, 'gate'),
      script: 'dist/index.js',
      env: { PORT: 3004 },
    },
    {
      name: 'kapow-technician',
      cwd: path.join(root, 'technician'),
      script: 'dist/index.js',
      env: { PORT: 3006, DATABASE_URL: DB_URL },
    },
    {
      name: 'kapow-comms',
      cwd: path.join(root, 'comms'),
      script: 'dist/index.js',
      env: {
        PORT: 3008,
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
      args: 'start -p 3005',
      env: { PORT: 3005, DATABASE_URL: DB_URL },
    },
  ],
};
