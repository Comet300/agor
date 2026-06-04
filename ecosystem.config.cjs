// PM2 process definition for agor.
//
//   pm2 start ecosystem.config.cjs      # start (reads ./.env via the app)
//   pm2 save                            # persist the process list
//   pm2 startup                         # generate the boot script (run the printed command)
//   pm2 logs agor                       # tail logs
//
// The app runs via `npm start` (tsx), reads configuration from environment, and
// stores its SQLite file at DATABASE_PATH. See DEPLOYMENT.md for the full runbook.
module.exports = {
  apps: [
    {
      name: 'agor',
      script: 'npm',
      args: 'start',
      cwd: __dirname,
      // Restart on crash; cap memory so a leak can't take down the Pi.
      autorestart: true,
      max_memory_restart: '300M',
      // Avoid a tight crash-loop if something is misconfigured at boot.
      restart_delay: 5000,
      min_uptime: '15s',
      max_restarts: 10,
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/agor.out.log',
      error_file: './logs/agor.err.log',
      time: true,
    },
  ],
};
