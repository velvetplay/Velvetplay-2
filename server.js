
const http = require('http');
const fs = require('fs');
const path = require('path');
const { posthogLog } = require('./lib/posthog-logs');

const publicDir = path.join(__dirname, 'public');
const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

function parseCookies(header) {
  const cookies = {};

  if (!header) return cookies;

  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (!key) continue;

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      // Ignore malformed cookies instead of crashing the request.
    }
  }

  return cookies;
}

async function readJsonBody(req) {
  const contentType = req.headers['content-type'] || '';
  const contentLength = Number(req.headers['content-length'] || 0);

  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    req.resume();
    const error = new Error('Request body too large');
    error.statusCode = 413;
    throw error;
  }

  const chunks = [];
  let totalSize = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buffer.length;

    if (totalSize > MAX_BODY_SIZE) {
      const error = new Error('Request body too large');
      error.statusCode = 413;
      throw error;
    }

    chunks.push(buffer);
  }

  if (!contentType.toLowerCase().includes('application/json')) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8');

  if (!raw.trim()) return {};

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error('Invalid JSON request body');
    error.statusCode = 400;
    throw error;
  }
}

function createResponse(res) {
  return {
    status(code) {
      res.statusCode = code;
      return this;
    },

    json(payload) {
      if (res.writableEnded) return;

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    },

    send(payload) {
      if (res.writableEnded) return;

      if (typeof payload === 'string') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(payload);
        return;
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
    },

    setHeader(name, value) {
      res.setHeader(name, value);
    }
  };
}

function isInsideDirectory(parent, target) {
  const relative = path.relative(parent, target);

  return (
    relative === '' ||
    (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
  );
}

function sendError(res, statusCode, message) {
  if (res.writableEnded) return;

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ error: message }));
}

async function serveStaticFile(res, pathname) {
  let safePath = pathname === '/' ? 'index.html' : pathname.slice(1);

  if (safePath.includes('\0')) {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  const requestedPath = path.resolve(publicDir, safePath);

  if (!isInsideDirectory(publicDir, requestedPath)) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }

  let rootRealPath;

  try {
    rootRealPath = await fs.promises.realpath(publicDir);
  } catch {
    res.statusCode = 500;
    res.end('Server configuration error');
    return;
  }

  let filePath = requestedPath;

  try {
    filePath = await fs.promises.realpath(requestedPath);

    if (!isInsideDirectory(rootRealPath, filePath)) {
      res.statusCode = 403;
      res.end('Forbidden');
      return;
    }

    const stats = await fs.promises.stat(filePath);

    if (!stats.isFile()) {
      throw new Error('Not a file');
    }
  } catch {
    // Preserve the existing single-page application fallback.
    filePath = path.join(rootRealPath, 'index.html');

    try {
      filePath = await fs.promises.realpath(filePath);

      if (!isInsideDirectory(rootRealPath, filePath)) {
        res.statusCode = 500;
        res.end('Server configuration error');
        return;
      }

      const fallbackStats = await fs.promises.stat(filePath);

      if (!fallbackStats.isFile()) {
        throw new Error('Fallback is not a file');
      }
    } catch {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
  }

  const ext = path.extname(filePath).toLowerCase();

  res.statusCode = 200;
  res.setHeader(
    'Content-Type',
    mimeTypes[ext] || 'application/octet-stream'
  );

  const stream = fs.createReadStream(filePath);

  stream.on('error', (error) => {
    console.error('Static file read error:', error);

    if (!res.headersSent) {
      sendError(res, 500, 'Unable to read file');
    } else if (!res.writableEnded) {
      res.destroy(error);
    }
  });

  stream.pipe(res);
}

function servePostHogInit(res) {
  const token = process.env.POSTHOG_PROJECT_TOKEN;
  const host = process.env.POSTHOG_HOST;
  const missingKey = token ? 'POSTHOG_HOST' : 'POSTHOG_PROJECT_TOKEN';
  const config = JSON.stringify({
    token,
    host,
    missingKey,
    production: process.env.NODE_ENV === 'production'
  }).replace(/</g, '\\u003c');

  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`(function (config) {
  if (!config.token || !config.host) {
    if (!config.production) {
      throw new Error(config.missingKey + ' variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ' + config.missingKey + ' is configured');
    }
    return;
  }

  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split('.');2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement('script')).type='text/javascript',p.crossOrigin='anonymous',p.async=!0,p.src=s.api_host.replace('.i.posthog.com','-assets.i.posthog.com')+'/static/array.js',(r=t.getElementsByTagName('script')[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a='posthog',u.people=u.people||[],Object.defineProperty(u,'toString',{configurable:!0,enumerable:!0,writable:!0,value:function(t){var e='posthog';return'posthog'!==a&&(e+='.'+a),t||(e+=' (stub)'),e}}),Object.defineProperty(u.people,'toString',{configurable:!0,enumerable:!0,writable:!0,value:function(){return u.toString(1)+'.people (stub)'}}),o='init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagResult isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug'.split(' '),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  window.posthog.init(config.token, {
    api_host: config.host,
    defaults: '2026-08-30',
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false
    }
  });
}(${config}));`);
}

async function routeRequest(req, res) {
  let url;
  let pathname;

  try {
    url = new URL(req.url, 'http://localhost');
    pathname = decodeURIComponent(url.pathname);
  } catch {
    res.statusCode = 400;
    res.end('Bad request');
    return;
  }

  req.query = Object.fromEntries(url.searchParams.entries());
  req.cookies = parseCookies(req.headers.cookie || '');
  req.body = await readJsonBody(req);

  if (pathname === '/api/posthog-init') {
    return servePostHogInit(res);
  }

  const routeMap = {
    '/api/session': require('./api/session.js'),
    '/api/me': require('./api/me.js'),
    '/api/video/usage': require('./api/video/usage.js'),
    '/api/payments/stk': require('./api/payments/stk.js')
  };

  if (routeMap[pathname]) {
    return routeMap[pathname](req, createResponse(res));
  }

  // Keep the fixed callback route before the parameterized payment route.
  if (pathname === '/api/payments/callback') {
    return require('./api/payments/callback.js')(
      req,
      createResponse(res)
    );
  }

  const paymentMatch = pathname.match(/^\/api\/payments\/([^/]+)$/);

  if (paymentMatch) {
    req.params = { id: paymentMatch[1] };
    req.query = {
      ...req.query,
      id: paymentMatch[1]
    };

    return require('./api/payments/[id].js')(
      req,
      createResponse(res)
    );
  }

  return serveStaticFile(res, pathname);
}

function createServer() {
  return http.createServer(async (req, res) => {
    try {
      await routeRequest(req, res);
    } catch (error) {
      if (error.statusCode === 413) {
        sendError(res, 413, 'Request body too large');
        return;
      }

      if (error.statusCode === 400) {
        sendError(res, 400, 'Invalid request');
        return;
      }

      console.error('Unhandled server error:', error);

      sendError(res, 500, 'Internal server error');
    }
  });
}

if (require.main === module) {
  const port = process.env.PORT || 3000;

  createServer().listen(port, () => {
    console.log(`VelvetPlay is running at http://localhost:${port}`);
    posthogLog('INFO', 'server_started');
  });
}

module.exports = {
  createServer,
  routeRequest,
  servePostHogInit
};
