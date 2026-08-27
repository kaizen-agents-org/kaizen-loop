import net from 'node:net';

const [socketPath, timeoutValue] = process.argv.slice(2);
const timeoutMs = Number(timeoutValue);

if (!socketPath?.startsWith('/') || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
  console.error('usage: wait-for-unix-socket.mjs <absolute-socket-path> <timeout-ms>');
  process.exit(2);
}

const deadline = Date.now() + timeoutMs;

function waitForReadySocket() {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${socketPath}`));
        return;
      }

      const socket = net.createConnection(socketPath);
      let settled = false;
      let response = '';
      const retry = () => {
        if (settled) return;
        settled = true;
        socket.destroy();
        setTimeout(attempt, 100);
      };

      socket.setTimeout(Math.min(500, Math.max(100, deadline - Date.now())));
      socket.once('connect', () => socket.write('{}\n'));
      socket.on('data', (chunk) => {
        response += chunk.toString('utf8');
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        try {
          const parsed = JSON.parse(response.slice(0, newline));
          if (typeof parsed?.ok !== 'boolean') {
            retry();
            return;
          }
          if (settled) return;
          settled = true;
          socket.destroy();
          resolve();
        } catch {
          retry();
        }
      });
      socket.once('error', retry);
      socket.once('timeout', retry);
      socket.once('end', retry);
    };

    attempt();
  });
}

try {
  await waitForReadySocket();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
