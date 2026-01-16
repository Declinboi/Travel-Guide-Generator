// ecosystem.config.js
module.exports = {
  apps: [
    // Main API Server
    {
      name: 'travel-api',
      script: 'dist/main.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=2048',
      env: {
        NODE_ENV: 'production',
        PORT: 4000,
      },
      env_development: {
        NODE_ENV: 'development',
        PORT: 4000,
      },
      max_memory_restart: '2G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      autorestart: true,
      watch: false,
      error_file: 'logs/api-error.log',
      out_file: 'logs/api-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 5000,
    },

    // Document Worker 1
    {
      name: 'document-worker-1',
      script: 'dist/workers/document-worker.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=4096',
      env: {
        NODE_ENV: 'production',
        WORKER_ID: '1',
        WORKER_NAME: 'document-worker-1',
      },
      env_development: {
        NODE_ENV: 'development',
        WORKER_ID: '1',
        WORKER_NAME: 'document-worker-1',
      },
      max_memory_restart: '4G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      autorestart: true,
      watch: false,
      error_file: 'logs/worker-1-error.log',
      out_file: 'logs/worker-1-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 30000, // Allow 30s for document generation to finish
    },

    // Document Worker 2
    {
      name: 'document-worker-2',
      script: 'dist/workers/document-worker.js',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--expose-gc --max-old-space-size=4096',
      env: {
        NODE_ENV: 'production',
        WORKER_ID: '2',
        WORKER_NAME: 'document-worker-2',
      },
      env_development: {
        NODE_ENV: 'development',
        WORKER_ID: '2',
        WORKER_NAME: 'document-worker-2',
      },
      max_memory_restart: '4G',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      autorestart: true,
      watch: false,
      error_file: 'logs/worker-2-error.log',
      out_file: 'logs/worker-2-out.log',
      merge_logs: true,
      time: true,
      kill_timeout: 30000,
    },
  ],

  // Deployment configuration (optional)
  deploy: {
    production: {
      user: 'node',
      host: 'your-server.com',
      ref: 'origin/main',
      repo: 'git@github.com:yourname/travel-guide-generator.git',
      path: '/var/www/travel-guide-generator',
      'post-deploy': 'npm install && npm run build && pm2 reload ecosystem.config.js',
    },
  },
};