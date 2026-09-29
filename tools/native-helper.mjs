// Edge native messaging host: wake the existing local HTTP helper on demand.
import { spawn } from 'node:child_process';

const helper = process.argv[2];
let input = Buffer.alloc(0);
process.stdin.on('data', (part) => {
  input = Buffer.concat([input, part]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32LE(0)) {
    const size = input.readUInt32LE(0);
    const body = input.subarray(4, 4 + size);
    input = input.subarray(4 + size);
    try {
      if (JSON.parse(body.toString()).action !== 'start') throw new Error('Unknown action');
      awaitStart().then((ok) => reply({ ok })).catch((error) => reply({ ok: false, error: error.message }));
    } catch (error) { reply({ ok: false, error: error.message }); }
  }
});

async function awaitStart() {
  if (await healthy()) return true;
  spawn(process.execPath, [helper], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (await healthy()) return true;
  }
  return false;
}

async function healthy() {
  try { return (await fetch('http://127.0.0.1:8766/health', { signal: AbortSignal.timeout(300) })).ok; }
  catch { return false; }
}

function reply(value) {
  const body = Buffer.from(JSON.stringify(value));
  const size = Buffer.alloc(4);
  size.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([size, body]));
}
