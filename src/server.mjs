import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY_BYTES = 16 * 1024;
const STATIC_FILES = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
]);

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json');
    error.statusCode = 415;
    throw error;
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function setSecurityHeaders(response) {
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self'; img-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Cache-Control', 'no-store');
}

function requestHostname(request) {
  try {
    return new URL(`http://${request.headers.host}`).hostname;
  } catch {
    return null;
  }
}

function validateBrowserBoundary(request, baseUrl) {
  if (requestHostname(request) !== baseUrl.hostname) {
    const error = new Error('Request host is not allowed');
    error.statusCode = 421;
    throw error;
  }

  if (request.method === 'POST') {
    const origin = request.headers.origin;
    if (origin && origin !== baseUrl.origin) {
      const error = new Error('Request origin is not allowed');
      error.statusCode = 403;
      throw error;
    }
    if (request.headers['sec-fetch-site'] === 'cross-site') {
      const error = new Error('Cross-site requests are not allowed');
      error.statusCode = 403;
      throw error;
    }
  }
}

async function serveStatic(response, publicDir, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;

  const [relativePath, contentType] = entry;
  const filePath = path.join(publicDir, relativePath);
  const info = await stat(filePath);
  response.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': info.size,
  });
  createReadStream(filePath).pipe(response);
  return true;
}

export function createScopeGuardServer({ service, controller, appBaseUrl, publicDir = DEFAULT_PUBLIC_DIR }) {
  if (!service || typeof service.proposeFromInstruction !== 'function') {
    throw new TypeError('service must implement proposeFromInstruction');
  }
  if (!controller || typeof controller.captureApprovedOrder !== 'function') {
    throw new TypeError('controller must implement captureApprovedOrder');
  }

  const baseUrl = new URL(appBaseUrl);
  return http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    const url = new URL(request.url || '/', baseUrl);

    try {
      validateBrowserBoundary(request, baseUrl);

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, { status: 'ok', paypalEnvironment: 'sandbox' });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/proposals') {
        const body = await readJson(request);
        const result = await service.proposeFromInstruction({
          clientRequestId: body.clientRequestId,
          instruction: body.instruction,
          returnUrl: `${baseUrl.origin}/?paypal=approved`,
          cancelUrl: `${baseUrl.origin}/?paypal=cancelled`,
        });
        sendJson(response, 200, result);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/api/capture') {
        const body = await readJson(request);
        const result = await controller.captureApprovedOrder(body.orderId);
        sendJson(response, result.success ? 200 : 409, result);
        return;
      }

      if (request.method === 'GET' && await serveStatic(response, publicDir, url.pathname)) return;
      sendJson(response, 404, { error: 'NOT_FOUND' });
    } catch (error) {
      const status = error.statusCode || (error instanceof TypeError ? 400 : 500);
      sendJson(response, status, {
        error: status === 500 ? 'INTERNAL_ERROR' : 'INVALID_REQUEST',
        message: status === 500 ? 'The request could not be completed' : error.message,
      });
    }
  });
}
