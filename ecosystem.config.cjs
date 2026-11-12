// API process heap is 192MB (node_args and NODE_OPTIONS must match).
// Full ingest runs in a forked child with --max-old-space-size=384 (src/config.js
// CHILD_MAX_OLD_SPACE) so NODE_OPTIONS=192 here does not cap the worker:
// the child's execArgv overrides NODE_OPTIONS for that flag.
module.exports = {
  apps: [
    {
      name: 'apiaberta-gtfs',
      script: 'src/index.js',
      node_args: '--max-old-space-size=192',
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production',
        PORT: 3018,
        NODE_OPTIONS: '--max-old-space-size=192',
        MONGO_URI: 'mongodb://localhost:27017/apiaberta-gtfs'
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000
    }
  ]
}
