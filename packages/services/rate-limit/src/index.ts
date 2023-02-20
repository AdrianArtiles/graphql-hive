#!/usr/bin/env node
import { createServer } from 'http';
import 'reflect-metadata';
import { createLogger, registerShutdown, startMetrics } from '@hive/service-common';
import * as Sentry from '@sentry/node';
import { env } from './environment';
import { rateLimitCtX, rateLimitRouter } from './router';

async function main() {
  if (env.sentry) {
    Sentry.init({
      serverName: 'rate-limit',
      enabled: !!env.sentry,
      environment: env.environment,
      dsn: env.sentry.dsn,
      release: env.release,
    });
  }

  const logger = createLogger();

  const server = createServer(rateLimitRouter);

  try {
    registerShutdown({
      logger,
      async onShutdown() {
        await Promise.all([rateLimitCtX.stop(), server.close()]);
      },
    });

    if (env.prometheus) {
      await startMetrics(env.prometheus.labels.instance);
    }
    await rateLimitCtX.start();
    return new Promise<void>(resolve => {
      server.listen(env.http.port, 'localhost', resolve);
    });
  } catch (error: any) {
    logger.fatal(error);
    Sentry.captureException(error, {
      level: 'fatal',
    });
  }
}

main().catch(err => {
  Sentry.captureException(err, {
    level: 'fatal',
  });
  console.error(err);
  process.exit(1);
});
