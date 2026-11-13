import { handle } from './mock';
const server = Bun.serve({
  hostname: Bun.env.HOST ?? '127.0.0.1',
  port: Number(Bun.env.PORT ?? 8080),
  maxRequestBodySize: 1024 * 1024,
  fetch: handle,
});
console.log(`VLOG mock: ${server.url}WorkflowInterface`);
