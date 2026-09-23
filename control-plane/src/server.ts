import { buildApp } from './app.js';
import { createRuntime } from './bootstrap.js';
import { migrate } from './db/migrate.js';
import { Scheduler } from './scheduler/scheduler.js';

const rt = await createRuntime();
const app = await buildApp(rt);

if (process.env.MIGRATE_ON_START !== 'false') {
  const applied = await migrate(rt.db);
  if (applied.length) app.log.info({ applied }, 'migrations applied');
}

const scheduler = new Scheduler(rt, app.log);
if (rt.config.SCHEDULER_ENABLED) scheduler.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 15_000).unref();
  try {
    await scheduler.stop();
    await app.close();
    await rt.close();
    clearTimeout(force);
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => app.log.error({ err }, 'unhandled rejection'));

await app.listen({ host: rt.config.HOST, port: rt.config.PORT });
