"""No models or network required: cache compatibility, integrity and audio contract."""
import array
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import wave
from unittest.mock import patch

workspace = tempfile.TemporaryDirectory(prefix='c2md-asr-test-')
os.environ['C2MD_DATA_DIR'] = workspace.name
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'tools'))
spec = importlib.util.spec_from_file_location('qwen_asr', Path(sys.path[0]) / 'qwen-asr.py')
asr = importlib.util.module_from_spec(spec)
spec.loader.exec_module(asr)
import runtime_download as runtime
from pins import VerifiedFiles


def wav(seconds, amplitude=500, quiet=()):
    """quiet: start times (s) of 100 ms stretches of silence, where the audio may be cut."""
    output = io.BytesIO()
    with wave.open(output, 'wb') as writer:
        writer.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        samples = array.array('h', [amplitude] * int(seconds * 16000))
        for at in quiet:
            first = int(at * 16000)
            samples[first:first + 1600] = array.array('h', [0] * 1600)
        if sys.byteorder != 'little':
            samples.byteswap()
        writer.writeframes(samples.tobytes())
    return output.getvalue()


class SharedAsr(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=workspace.name)
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict(os.environ, {'XDG_CONFIG_HOME': str(self.root / 'config'),
                                         'XDG_CACHE_HOME': str(self.root / 'cache')})
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop('C2MD_MODEL_DIR', None)

    def test_upstream_paths_and_preserve_explicit_choice(self):
        self.assertEqual(asr.model_dir(), self.root / 'cache/course2md/models')
        target = self.root / 'shared'
        self.assertEqual(asr.configure_models(target), target)
        self.assertEqual(asr.configure_models(self.root / 'other'), target)
        before = asr.config_path().read_bytes()
        self.assertEqual(asr.configure_models(target), target)
        self.assertEqual(asr.config_path().read_bytes(), before)

    def test_models_the_original_already_downloaded_are_reused_where_they_are(self):
        folder = asr.default_model_dir() / 'llama-qwen3-1.7b'
        folder.mkdir(parents=True)
        for name in asr.PINS['qwen-asr']['sha256']:
            (folder / name).write_bytes(b'GGUF')
        self.assertEqual(asr.configure_models(self.root / 'moved' / 'models'), asr.default_model_dir())
        self.assertFalse(asr.config_path().exists(), 'no model_dir written: the original keeps using its copy')

    def test_helper_with_a_moved_data_dir_shares_the_model_there_on_first_use(self):
        target = self.root / 'moved' / 'models'
        with patch.dict(os.environ, {'C2MD_SHARED_MODEL_TARGET': str(target)}):
            self.assertEqual(asr.shared_root(), target)
            self.assertIn(str(target.resolve()).replace('\\', '\\\\'), asr.config_path().read_text(encoding='utf-8'))
            # an explicit C2MD_MODEL_DIR is the user's choice: config.toml is not consulted or written
            asr.config_path().unlink()
            with patch.dict(os.environ, {'C2MD_MODEL_DIR': str(self.root / 'explicit')}):
                self.assertEqual(asr.shared_root(), (self.root / 'explicit').resolve())
            self.assertFalse(asr.config_path().exists())
        # without a moved data dir nothing is written: the original's own default is used
        self.assertEqual(asr.shared_root(), asr.default_model_dir())
        self.assertFalse(asr.config_path().exists())

    def test_config_preserves_comments_and_other_settings(self):
        config = asr.config_path()
        config.parent.mkdir(parents=True)
        config.write_text('# keep\n[defaults] # user preferences\nsimilarity = 0.8\n[llm]\nmodel = "existing"\n')
        asr.configure_models(self.root / 'models')
        content = config.read_text()
        self.assertIn('# keep', content)
        self.assertIn('similarity = 0.8', content)
        self.assertEqual(asr.tomllib.loads(content)['llm']['model'], 'existing')
        config.write_text('[defaults\nbroken')
        with self.assertRaises(ValueError):
            asr.model_dir()
        self.assertEqual(config.read_text(), '[defaults\nbroken')

    def test_shared_cache_is_used_offline_and_mismatch_is_not_deleted(self):
        target = self.root / 'existing.gguf'
        target.write_bytes(b'existing verified model')
        verified = VerifiedFiles(self.root / 'verified.json')
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
        with patch.object(runtime.urllib.request, 'urlopen', side_effect=AssertionError('network called')):
            self.assertEqual(runtime.pinned_download('https://unused', target, digest, '', verified, True), target)
            with self.assertRaisesRegex(RuntimeError, '共享模型'):
                runtime.pinned_download('https://unused', target, '0'*64, '', verified, True)
        self.assertEqual(target.read_bytes(), b'existing verified model')

    def test_http_ignores_range_restarts_download(self):
        target = self.root / 'download'
        target.with_suffix('.part').write_bytes(b'ab')
        head = io.BytesIO()
        head.headers = {'Content-Length': '6'}
        body = io.BytesIO(b'abcdef')
        body.headers = {'Content-Length': '6'}
        body.status = 200
        with patch.object(runtime.urllib.request, 'urlopen', side_effect=[head, body]):
            runtime.robust_download('https://unused', target, 'test')
        self.assertEqual(target.read_bytes(), b'abcdef')

    def test_transcript_bounds_silence_and_truncation(self):
        def response(_request, **_kwargs):
            return io.BytesIO(json.dumps({'choices': [{'message': {'content': 'language Chinese<asr_text>你好。'},
                                                     'finish_reason': 'stop'}]}).encode())
        with patch.object(asr.urllib.request, 'urlopen', side_effect=response) as call:
            # The helper's 20-second pieces carry 0.25 s of silence on each end: still one request
            value = asr.transcribe(wav(20.5), 'http://localhost:1', 'test-key')
            self.assertEqual([(s['start'], s['end']) for s in value['segments']], [(0, 20.5)])
            self.assertEqual(value['segments'][0]['text'], '你好。')
            self.assertEqual(call.call_count, 1)
            # Longer audio is cut at the quietest 100 ms before each 20-second limit, not mid-word
            value = asr.transcribe(wav(45, quiet=(18.5, 36.0)), 'http://localhost:1', 'test-key')
            self.assertEqual([(s['start'], s['end']) for s in value['segments']],
                             [(0, 18.55), (18.55, 36.05), (36.05, 45)])
            self.assertEqual(call.call_count, 4)
            self.assertEqual(asr.transcribe(wav(1, 0), '', '')['segments'], [])
            self.assertEqual(call.call_count, 4)
        truncated = io.BytesIO(b'{"choices":[{"finish_reason":"length"}]}')
        with patch.object(asr.urllib.request, 'urlopen', return_value=truncated):
            with self.assertRaisesRegex(RuntimeError, '长度限制'):
                asr.transcribe(wav(1), 'http://localhost:1', '')

    def test_gpu_is_used_only_when_llama_server_lists_one(self):
        from types import SimpleNamespace
        listing = lambda text: SimpleNamespace(returncode=0, stdout=text, stderr='')
        cpu_only = 'load_backend: loaded CPU backend\nAvailable devices:\n  BLAS: OpenBLAS\n'
        cuda = 'Available devices:\n  CUDA0: NVIDIA GeForce RTX 4060 Laptop GPU (8187 MiB, 7097 MiB free)\n'
        with patch.object(asr.subprocess, 'run', return_value=listing(cpu_only)):
            self.assertFalse(asr.gpu_available('llama-server'))
        with patch.object(asr.subprocess, 'run', return_value=listing(cuda)):
            self.assertTrue(asr.gpu_available('llama-server'))
        with patch.object(asr.subprocess, 'run', side_effect=OSError('missing')):
            self.assertFalse(asr.gpu_available('llama-server'))

    def test_browser_recording_is_converted(self):
        from types import SimpleNamespace
        decoded = SimpleNamespace(returncode=0, stdout=bytes(32000), stderr=b'')
        with patch.object(asr.subprocess, 'run', return_value=decoded) as ffmpeg:
            self.assertEqual(asr.transcribe(b'webm recording', '', '')['text'], '')
        self.assertEqual(ffmpeg.call_args.kwargs['input'], b'webm recording')


if __name__ == '__main__':
    try:
        unittest.main()
    finally:
        workspace.cleanup()
