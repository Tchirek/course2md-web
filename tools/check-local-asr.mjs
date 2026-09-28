import { transcribe, silentWav } from '../src/background/asr.js';

const status = await (await fetch('http://127.0.0.1:8765/asr/status')).json();
if (status.state !== 'ready') throw new Error(status.message);
const probe = await transcribe({
  endpoint: 'http://127.0.0.1:8080/v1/audio/transcriptions',
  model: 'small',
  audio: silentWav(0.1),
  mimeType: 'audio/wav',
  fileName: 'probe.wav',
});
if (!probe.ok) throw new Error(probe.error);
process.stdout.write('本机转录端点已接收 WAV 并返回成功。\n');
