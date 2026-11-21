"""Offline CLI worker contract, checkout and process supervision tests."""
import base64
import contextlib
import functools
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from agent import cli_runner as worker


class Queue:
    def __init__(self, mode='operator'):
        self.claim = {'run': {'id': 'job', 'task_id': 'task', 'mode': mode, 'question': 'What changed?'},
                      'lease': 'fake-lease', 'context': {'project': {'id': 'p', 'repo': 'Org/Example',
                      'name': 'Example', 'agent_instructions': 'Run unit tests.', 'agent_key': 'PRIVATE'},
                      'task': {'id': 'task', 'title': 'Example', 'body': 'Review this', 'requirements': '',
                      'delivery_ref': 'https://github.com/Org/Example/pull/3'},
                      'messages': [{'author': 'human', 'body': 'Inspect tests.', 'private': 'PRIVATE'}]}}
        self.events = []

    def post(self, route, **payload):
        if route == 'claim':
            assert payload == {}
            return self.claim
        assert route == 'runs/job/events'
        assert payload['lease'] == 'fake-lease'
        self.events.append(payload)
        return {'run': {}}


def opts():
    return SimpleNamespace(project='p', repo='org/example', key='WEB_AGENT', github_token='GH_TOKEN',
                           model_key='MODEL_KEY', cli='codex', timeout=20, interval=1)


class CliTest(unittest.TestCase):
    def test_http_contract_and_auth_no_redirect(self):
        calls = []

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                calls.append((self.path, self.headers.get('Authorization'),
                              json.loads(self.rfile.read(int(self.headers['Content-Length'])))))
                if self.path.endswith('/claim'):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(b'{"run":null}')
                else:
                    self.send_response(307)
                    self.send_header('Location', '/other')
                    self.end_headers()

            def log_message(self, *args):
                pass

        with HTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                api = worker.Api(f'http://127.0.0.1:{server.server_port}', 'p', 'testkey')
                self.assertFalse(worker.cycle(api, opts()))
                with self.assertRaises(worker.HttpFailure) as rejected:
                    api.post('runs/x/events', lease='fake', event='heartbeat')
                self.assertEqual(rejected.exception.status, 307)
            finally:
                server.shutdown()
                thread.join()
        self.assertEqual(calls, [('/api/projects/p/agent/cli/claim', 'Bearer testkey', {}),
                                 ('/api/projects/p/agent/cli/runs/x/events', 'Bearer testkey',
                                  {'lease': 'fake', 'event': 'heartbeat'})])
        with self.assertRaises(ValueError):
            worker.Api('http://remote.invalid', 'p', 'testkey')

    def test_binding_and_strict_delivery_ref(self):
        for ref in ('other/repo#1', 'HEAD', 'https://github.com.evil/org/example/pull/3',
                    'https://github.com/org/example/pull/0', 'https://github.com/other/repo/pull/2',
                    'https://github.com/org/example/pull/1?ref=main', 'https://github.com/org/example/pull/1/x',
                    'https://github.com/org/example/pull/１２', 'https://github.com/org/example/pull/1#frag',
                    'https://user@github.com/org/example/pull/1'):
            with self.subTest(ref=ref), self.assertRaises(worker.JobError):
                worker.pull_number(ref, 'org/example')
        for key, value in [('repo', 'other/repo'), ('id', 'elsewhere')]:
            queue = Queue('pr_audit')
            queue.claim['context']['project'][key] = value
            with patch.object(worker, 'prepare') as prep:
                worker.cycle(queue, opts())
                prep.assert_not_called()
            self.assertEqual(queue.events[-1]['event'], 'fail')
        self.assertEqual(worker.pull_number('https://github.com/Org/Example/pull/3/', 'org/example'), '3')

    def test_pr_metadata_rejects_fork_or_deleted_source(self):
        meta = {'number': 3, 'base': {'sha': 'a' * 40, 'repo': {'full_name': 'org/example'}},
                'head': {'sha': 'b' * 40, 'repo': {'full_name': 'Org/Example'}}}
        with patch.object(worker, 'request_json', return_value=meta):
            self.assertEqual(worker.pull_context('org/example', '3', ''), ('a' * 40, 'b' * 40))
            for source in (None, {'full_name': 'external/example'}):
                meta['head']['repo'] = source
                with self.assertRaisesRegex(worker.JobError, 'External fork'):
                    worker.pull_context('org/example', '3', '')
            del meta['head']['repo']
            with self.assertRaisesRegex(worker.JobError, 'External fork'):
                worker.pull_context('org/example', '3', '')

    def test_real_git_pr_tree_and_nondefault_merge_base(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / 'fixture'
            source.mkdir()

            def git(*args):
                env = dict(worker.work_env(source), GIT_AUTHOR_NAME='Fixture', GIT_COMMITTER_NAME='Fixture',
                           GIT_AUTHOR_EMAIL='fixture@invalid', GIT_COMMITTER_EMAIL='fixture@invalid')
                return subprocess.check_output(['/usr/bin/git', '-C', str(source), *args],
                                               env=env, stderr=subprocess.DEVNULL, text=True).strip()

            git('init', '--template=', '-b', 'main')
            git('commit', '--allow-empty', '-m', 'default')
            default = git('rev-parse', 'HEAD')
            git('switch', '-c', 'release')
            git('commit', '--allow-empty', '-m', 'release fork point')
            merge_base = git('rev-parse', 'HEAD')
            git('commit', '--allow-empty', '-m', 'advance base')
            base = git('rev-parse', 'HEAD')
            git('switch', '--detach', merge_base)
            (source / 'change.txt').write_text('PR change')
            git('add', 'change.txt')
            git('commit', '-m', 'PR head')
            head = git('rev-parse', 'HEAD')
            git('update-ref', 'refs/pull/3/head', head)
            git('switch', 'main')
            # Use a local Git fixture in place of the network transport only.
            real_run = worker.run_command
            fetches = []

            def command(args, cwd, env, writable, tick, **kwargs):
                target = 'https://github.com/org/example.git'
                if target in args:
                    fetches.append(args.copy())
                    args = [str(source) if x == target else x for x in args]
                    self.assertIn('Authorization: Basic ', str(env))
                    env = dict(env, GIT_ALLOW_PROTOCOL='file')
                else:
                    self.assertNotIn('Authorization: Basic ', str(env))
                return real_run(args, cwd, env, writable, tick, restrict=lambda _: None, **kwargs)

            def checkout(name, expected):
                work = root / name
                for d in (work, work / 'repo', work / 'home', work / 'tmp'):
                    d.mkdir()
                with patch.object(worker, 'run_command', command), patch.object(
                        worker, 'pull_context', return_value=(base, expected)):
                    return worker.prepare(work, 'org/example', '3', 'dummy-token', lambda: None)

            self.assertEqual(checkout('ok', head), (head, merge_base))
            self.assertNotEqual(default, merge_base)
            self.assertNotEqual(base, merge_base)
            self.assertEqual((root / 'ok/repo/change.txt').read_text(), 'PR change')
            self.assertIn('+refs/pull/3/head:refs/relay/head', fetches[0])
            with self.assertRaisesRegex(worker.JobError, 'changed'):
                checkout('moved', default)
            git('update-ref', '-d', 'refs/pull/3/head')
            with self.assertRaisesRegex(worker.JobError, 'Git fetch failed'):
                checkout('deleted', head)

    def test_noninteractive_tools_environment_and_no_web_secrets(self):
        with patch.dict(os.environ, {'RELAYDESK_AGENT_KEY': 'WEB', 'AWS_SECRET_ACCESS_KEY': 'AWS',
                                     'NODE_OPTIONS': '-r compromised', 'GIT_CONFIG_COUNT': '55',
                                     'ANTHROPIC_BASE_URL': 'https://evil.invalid', 'PATH': '.'}):
            base = worker.work_env(Path('/tmp/job'))
            for name, flag in [('codex', 'exec'), ('claude', '-p')]:
                args, env = worker.cli_command(name, base, 'test-model-key')
                self.assertTrue(args[0].startswith('/usr/local/bin/'))
                self.assertIn(flag, args)
                self.assertNotIn('test-model-key', str(args))
                for key in ('RELAYDESK_AGENT_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS',
                            'GIT_CONFIG_COUNT', 'ANTHROPIC_BASE_URL', 'RELAYDESK_GITHUB_TOKEN'):
                    self.assertNotIn(key, env)
            auth = worker.git_env(base, 'fake-token')
            self.assertIn(base64.b64encode(b'x-access-token:fake-token').decode(), str(auth))
            self.assertNotIn('Authorization:', str(worker.git_env(base)))

    def test_job_progress_final_and_context_allowlist(self):
        q = Queue('pr_audit')
        config = opts()
        seen = {}

        def fake_cli(args, cwd, env, writable, tick, *, prompt, stage):
            seen.update(prompt=prompt.decode(), work=cwd)
            self.assertNotIn('WEB_AGENT', str(env))
            self.assertNotIn('GH_TOKEN', str(env))
            return 'a GH_TOKEN WEB_AGENT fake-lease MODEL_KEY result' + 'x' * 30000

        with patch.object(worker, 'handbook', return_value='External handbook'), patch.object(
                worker, 'workspace', side_effect=lambda p: p), patch.object(
                worker, 'prepare', return_value=('a' * 40, 'b' * 40)), patch.object(worker, 'run_command', fake_cli):
            self.assertTrue(worker.cycle(q, config))
        events = [item['event'] for item in q.events]
        self.assertEqual(events, ['heartbeat', 'progress', 'progress', 'finish'])
        self.assertIn('External handbook', seen['prompt'])
        self.assertIn('Inspect tests.', seen['prompt'])
        self.assertIn('Run unit tests.', seen['prompt'])
        self.assertIn('b' * 40 + ' ' + 'a' * 40, seen['prompt'])
        self.assertNotIn('PRIVATE', seen['prompt'])
        self.assertFalse(seen['work'].exists())
        result = q.events[-1]
        self.assertEqual(result['sha'], 'a' * 40)
        self.assertIn(worker.DISPOSABLE, result['body'])
        self.assertLess(len(result['body']), 24000)
        for secret in (config.key, config.github_token, config.model_key, 'fake-lease'):
            self.assertNotIn(secret, result['body'])

    def test_real_process_output_bounded_and_stderr_not_reported(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run = functools.partial(worker.run_command, cwd=root, env=worker.work_env(root), writable=root,
                                    tick=lambda: None, restrict=lambda _: None, stdout_limit=20)
            out = run([sys.executable, '-I', '-c', "import sys; print('x'*100000); print('private',file=sys.stderr)"])
            self.assertEqual(out, 'x' * 20 + '\n[output truncated]')
            with self.assertRaisesRegex(worker.JobError, r'^Command failed \(exit 12\)\.$'):
                run([sys.executable, '-I', '-c', "import sys; print('private'); sys.exit(12)"])

    def test_lost_lease_and_timeout_stop_real_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for kind in ('fenced', 'timeout'):
                q = Queue()
                pidfile = root / kind
                config = opts()
                config.interval = .05
                config.timeout = 4 if kind == 'fenced' else .7
                original = q.post

                def fence(route, **payload):
                    if kind == 'fenced' and payload.get('event') == 'heartbeat' and pidfile.exists():
                        raise worker.HttpFailure(409)
                    return original(route, **payload)

                def execute(claim, opts, lease):
                    code = 'import pathlib,os,sys,time;pathlib.Path(sys.argv[1]).write_text(str(os.getpid()));time.sleep(20)'
                    worker.run_command([sys.executable, '-I', '-c', code, str(pidfile)], root,
                                       worker.work_env(root), root, lease.check, restrict=lambda _: None)
                    self.fail('process must be cancelled')

                q.post = fence
                ctx = self.assertRaises(worker.HttpFailure) if kind == 'fenced' else contextlib.nullcontext()
                start = time.monotonic()
                with patch.object(worker, 'execute', execute), ctx:
                    worker.cycle(q, config)
                self.assertLess(time.monotonic() - start, 5)
                with self.assertRaises(ProcessLookupError):
                    os.kill(int(pidfile.read_text()), 0)
                self.assertEqual(q.events[-1]['event'], 'heartbeat' if kind == 'fenced' else 'fail')

    def test_handbook_symlink_and_size_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / 'guide'
            link = target.with_suffix('.link')
            self.assertEqual(worker.handbook(target), '')
            target.write_text('project-specific guidance')
            self.assertEqual(worker.handbook(target), target.read_text())
            link.symlink_to(target)
            with self.assertRaises(OSError):
                worker.handbook(link)
            target.write_bytes(b'x' * 32769)
            with self.assertRaises(worker.JobError):
                worker.handbook(target)


if __name__ == '__main__':
    unittest.main()
