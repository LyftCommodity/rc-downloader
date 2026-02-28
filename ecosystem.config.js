// PM2 ecosystem config
// Usage:
//   pm2 start ecosystem.config.js          # start
//   pm2 save                               # persist process list across reboots
//   pm2 startup                            # generate OS boot hook (run the printed command)
//   pm2 logs rc-recorder                   # tail logs
//   pm2 restart rc-recorder                # restart
//   pm2 monit                              # live dashboard

module.exports = {
  apps: [
    {
      name: "rc-recorder",
      script: "index.js",

      // Restart automatically on crash
      autorestart: true,

      // Wait 5 seconds before restarting after a crash
      restart_delay: 5000,

      // Restart if the process uses more than 500 MB RAM
      max_memory_restart: "500M",

      // Don't count as a crash if the process lived less than 10 seconds
      min_uptime: "10s",

      // Maximum number of consecutive restarts before PM2 gives up
      max_restarts: 10,

      // Log files (PM2 rotates these automatically with pm2-logrotate)
      out_file:   "./logs/out.log",
      error_file: "./logs/error.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",

      // Environment variables for production
      // All secrets should live in .env — this just sets NODE_ENV
      env_production: {
        NODE_ENV: "production",
      },

      // Watch mode — NOT recommended for production, useful for dev
      watch: false,
    },
  ],
};
