// PM2 ecosystem config — for running on a bare VM without Docker
// Usage: pm2 start ecosystem.config.cjs

const path = require('path');
const root = __dirname;

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
      name: 'kapow-actions',
      cwd: path.join(root, 'actions'),
      script: 'dist/index.js',
      env: {
        PORT: 3000,
        PLANNER_URL: 'http://localhost:3001',
        BUILDER_URL: 'http://localhost:3002',
        QA_URL: 'http://localhost:3003',
        GATE_URL: 'http://localhost:3004',
      },
    },
    {
      name: 'kapow-board',
      cwd: path.join(root, 'board'),
      script: 'node_modules/.bin/next',
      args: 'start -p 3005',
      env: { PORT: 3005 },
    },
  ],
};
