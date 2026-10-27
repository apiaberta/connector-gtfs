module.exports = {
  apps: [
    {
      name: 'apiaberta-gtfs',
      script: 'src/index.js',
      node_args: '--max-old-space-size=256',
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
        PORT: 3018,
        MONGO_URI: 'mongodb://localhost:27017/apiaberta-gtfs'
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000
    }
  ]
}
