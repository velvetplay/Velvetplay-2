const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;
const missingKey = token ? 'POSTHOG_HOST' : 'POSTHOG_PROJECT_TOKEN';

let posthogLogger = null;

if (!token || !host) {
  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      `${missingKey} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingKey} is configured`
    );
  }
} else {
  const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const {
    BatchLogRecordProcessor,
    LoggerProvider
  } = require('@opentelemetry/sdk-logs');

  const loggerProvider = new LoggerProvider({
    resource: resourceFromAttributes({
      'service.name': 'velvetplay'
    }),
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          url: `${host.replace(/\/$/, '')}/i/v1/logs`,
          headers: {
            Authorization: `Bearer ${token}`
          }
        })
      )
    ]
  });

  posthogLogger = loggerProvider.getLogger('velvetplay.posthog');

  let shutdownPromise;
  const flushLogs = () => {
    if (!shutdownPromise) {
      shutdownPromise = loggerProvider.shutdown().catch(() => {});
    }

    return shutdownPromise;
  };

  process.once('beforeExit', () => {
    void flushLogs();
  });

  for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 0]]) {
    process.once(signal, () => {
      const timeout = new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        timer.unref();
      });

      void Promise.race([flushLogs(), timeout]).finally(() => {
        process.exit(exitCode);
      });
    });
  }
}

function posthogLog(severityText, body, attributes) {
  if (!posthogLogger) return;

  try {
    posthogLogger.emit({
      severityText,
      body,
      attributes
    });
  } catch {}
}

module.exports = {
  posthogLog
};
