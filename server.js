'use strict';
const { createApp } = require('./src/app');

const app = createApp();
const { port, host, geminiKey } = app.cfg;

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  app.logger.reportError(err, { source: 'unhandledRejection' });
});

process.on('uncaughtException', (err) => {
  Promise.resolve(app.logger.reportError(err, { source: 'uncaughtException' }))
    .finally(() => {
      app.close().catch(() => {}).finally(() => process.exit(1));
    });
});

app.server.listen(port, host, () => {
  console.log(`OrderFlow يعمل على http://localhost:${port}`);
  if (!geminiKey) console.log('تنبيه: GEMINI_API_KEY غير مضبوط — ستعمل ميزات الذكاء الاصطناعي بقوالب جاهزة.');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.close().then(() => process.exit(0)));
}
