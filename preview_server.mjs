import { createScopeGuardServer } from './src/server.mjs';

const unavailable = () => {
  const error = new Error('Preview mode does not call an AI provider or PayPal');
  error.statusCode = 503;
  throw error;
};
const server = createScopeGuardServer({
  service: { proposeFromInstruction: unavailable },
  controller: { captureApprovedOrder: unavailable },
  appBaseUrl: 'http://127.0.0.1:8799',
});

server.listen(8799, '127.0.0.1', () => {
  console.log('Static ScopeGuard UI preview listening at http://127.0.0.1:8799');
});
