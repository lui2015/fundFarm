module.exports = {
  apps: [
    {
      name: 'fundfarm',
      script: './server.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3290,
        TZ: 'Asia/Shanghai',
        DATA_DIR: './data',
      },
    },
  ],
};
