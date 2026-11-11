import { createApp } from './app';

const port = Number(process.env['PORT'] ?? '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
}
export default { hostname: '127.0.0.1', port, fetch: createApp().fetch };
