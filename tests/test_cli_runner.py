"""Offline CLI worker contract, checkout and process supervision tests."""
import base64
import contextlib
import functools
import io
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
            assert payload == heartbeat()
            return self.claim
        assert route == 'runs/job/events'
        assert payload['lease'] == 'fake-lease'
        self.events.append(payload)
        return {'run': {}}


def heartbeat(runtime='codex', ready=True):
    return {'runtime': runtime, 'managed': True, 'ready': ready, 'protocol': 2}


def opts():
    return SimpleNamespace(project='p', repo='org/example', key='WEB_AGENT', timeout=20, interval=1,
                           settings=worker.CliSettings('codex', '', '', 'MODEL_KEY', 'GH_TOKEN'))


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
        self.assertEqual(calls, [('/api/projects/p/agent/cli/claim', 'Bearer testkey', heartbeat()),
                                 ('/api/projects/p/agent/cli/runs/x/events', 'Bearer testkey',
                                  {'lease': 'fake', 'event': 'heartbeat'})])
        with self.assertRaises(ValueError):
            worker.Api('http://remote.invalid', 'p', 'testkey')

    def test_managed_polls_reload_settings_and_gate_jobs(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'settings.json'
            env = {'RELAYDESK_URL': 'http://localhost', 'RELAYDESK_PROJECT': 'p',
                   'RELAYDESK_REPO': 'org/example', 'RELAYDESK_AGENT_KEY': 'agent',
                   'RELAYDESK_CLI_CONFIG_FILE': str(path), 'RELAYDESK_CLI': 'claude',
                   'CODEX_API_KEY': 'env-key', 'ANTHROPIC_API_KEY': 'env-key',
                   'RELAYDESK_GITHUB_TOKEN': 'env-token'}
            codex = dict(project_id='p', runtime='codex', endpoint='https://codex.invalid/v1',
                         model='codex-model', api_key='first-key', github_token='file-token')
            claude = dict(project_id='p', runtime='claude', endpoint='https://claude.invalid',
                          model='claude-model', api_key='second-key', github_token='')
            snapshots = [None, codex, claude, dict(claude, api_key='rotated-key'), None,
                         dict(codex, project_id='P'), dict(claude, runtime='invalid'), dict(claude, api_key='')]
            polls, jobs = [], []
            queue = Queue()
            stderr = io.StringIO()

            def post(route, **payload):
                if route != 'claim':
                    return queue.post(route, **payload)
                polls.append(payload)
                # An incompatible server returns a job on every poll except the first.
                return {'run': None} if len(polls) == 1 else queue.claim

            def execute(claim, config, lease):
                jobs.append(config.settings)
                return 'a' * 40, 'done'

            def next_poll(interval):
                if len(polls) == len(snapshots):
                    raise StopIteration
                snapshot = snapshots[len(polls)]
                if snapshot is None:
                    path.unlink()
                else:
                    staging = path.with_suffix('.new')
                    staging.write_text(json.dumps(snapshot))
                    staging.chmod(0o600)
                    staging.replace(path)

            with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['runner']), \
                    patch.object(worker.os, 'umask'), patch.object(worker.sandbox, 'enable_supervisor'), \
                    patch.object(worker, 'Api') as api, patch.object(worker, 'execute', execute), \
                    patch.object(worker.time, 'sleep', next_poll), contextlib.redirect_stderr(stderr):
                api.return_value.post.side_effect = post
                with self.assertRaises(StopIteration):
                    worker.main()
            self.assertEqual(polls, [heartbeat(ready=False), heartbeat(), heartbeat('claude'),
                                     heartbeat('claude'), *[heartbeat(ready=False)] * 3, heartbeat('claude', False)])
            self.assertEqual(jobs, [worker.CliSettings(**{k: v for k, v in snap.items() if k != 'project_id'})
                                    for snap in snapshots[1:4]])
            self.assertEqual([e['event'] for e in queue.events], ['heartbeat', 'finish'] * 3)
            for secret in ('env-key', 'env-token', 'first-key', 'second-key', 'rotated-key', 'file-token'):
                self.assertNotIn(secret, stderr.getvalue() + str(polls) + str(queue.events) + repr(jobs))

    def test_settings_reject_invalid_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'settings.json'
            valid = dict(project_id='p', runtime='codex', endpoint='', model='', api_key='key', github_token='token')
            invalid = [[], {}, {k: v for k, v in valid.items() if k != 'runtime'},
                       dict(valid, project_id=1), dict(valid, project_id='p '), dict(valid, runtime=[]),
                       dict(valid, api_key=None), dict(valid, api_key='  '),
                       dict(valid, api_key='key\x00'), dict(valid, github_token=42),
                       dict(valid, github_token='first\r\nsecond'), dict(valid, endpoint=None),
                       dict(valid, model=3), dict(valid, model='a\nb'), dict(valid, model='--help'),
                       dict(valid, model='a-key'), dict(valid, endpoint='https://host/token')]
            for raw in (b'not json', b'\xff', b'[' * 2000 + b']' * 2000,
                        json.dumps(valid).encode() + b' ' * worker.MAX_SETTINGS,
                        *(json.dumps(obj).encode() for obj in invalid)):
                path.write_bytes(raw)
                path.chmod(0o600)
                self.assertIsNone(worker.read_settings(path, 'p'))
            path.write_text(json.dumps(dict(valid, public_ai_enabled=False)))
            for mode in (0o600, 0o400):
                path.chmod(mode)
                self.assertEqual(worker.read_settings(path, 'p'), worker.CliSettings('codex', '', '', 'key', 'token'))
            link = path.with_suffix('.link')
            link.symlink_to(path)
            fifo = path.with_suffix('.fifo')
            os.mkfifo(fifo, 0o600)
            for unsafe in (link, fifo, Path(tmp)):
                self.assertIsNone(worker.read_settings(unsafe, 'p'))
            for mode in (0o640, 0o604, 0o666):
                path.chmod(mode)
                self.assertIsNone(worker.read_settings(path, 'p'))

    def test_endpoint_validation(self):
        for endpoint in ('', 'https://models.example/v1', 'http://localhost:8080/prefix',
                         'http://127.43.2.1:4/v1', 'http://[::1]:1234/v1'):
            self.assertTrue(worker.valid_endpoint(endpoint), endpoint)
        for endpoint in ('http://example.com', 'http://localhost.example.com', '//localhost',
                         'https://user@host', 'https://@host', 'https://user:password@host',
                         'https://host?', 'https://host#', 'https://host/a?q=1', 'https://host/a#f',
                         'https://host:99999', 'http://[::1]other', 'https://host\\other',
                         'https://host/"\nmodel_provider="x', 'https://host/\x00', 'https:///v1'):
            self.assertFalse(worker.valid_endpoint(endpoint), endpoint)

    def test_missing_default_settings_ignores_all_legacy_credentials(self):
        env = {'RELAYDESK_URL': 'http://localhost', 'RELAYDESK_PROJECT': 'p',
               'RELAYDESK_REPO': 'org/example', 'RELAYDESK_AGENT_KEY': 'agent',
               'RELAYDESK_CLI': 'claude', 'RELAYDESK_CODEX_CREDENTIALS_FILE': '/old/path',
               'CODEX_API_KEY': 'codex-key', 'ANTHROPIC_API_KEY': 'claude-key',
               'RELAYDESK_GITHUB_TOKEN': 'env-token'}
        with patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', ['runner', '--once']), \
                patch.object(worker.os, 'umask'), patch.object(worker.sandbox, 'enable_supervisor'), \
                patch.object(worker, 'read_settings', return_value=None) as load, patch.object(worker, 'Api') as api:
            api.return_value.post.return_value = {'run': None}
            worker.main()
            load.assert_called_once_with('/run/relaydesk/cli/settings.json', 'p', 'agent')
            api.return_value.post.assert_called_once_with('claim', **heartbeat(ready=False))

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
                args, env = worker.cli_command(worker.CliSettings(name, '', '', 'test-model-key', ''), base)
                self.assertTrue(args[0].startswith('/usr/local/bin/'))
                self.assertIn(flag, args)
                self.assertNotIn('-m', args)
                self.assertNotIn('--model', args)
                self.assertNotIn('model_provider=', ' '.join(args))
                self.assertEqual(env['CODEX_API_KEY' if name == 'codex' else 'ANTHROPIC_API_KEY'], 'test-model-key')
                self.assertNotIn('test-model-key', str(args))
                for key in ('RELAYDESK_AGENT_KEY', 'AWS_SECRET_ACCESS_KEY', 'NODE_OPTIONS',
                            'GIT_CONFIG_COUNT', 'ANTHROPIC_BASE_URL', 'RELAYDESK_GITHUB_TOKEN'):
                    self.assertNotIn(key, env)
            auth = worker.git_env(base, 'fake-token')
            self.assertIn(base64.b64encode(b'x-access-token:fake-token').decode(), str(auth))
            self.assertNotIn('Authorization:', str(worker.git_env(base)))

    def test_custom_providers_use_only_managed_key_and_literal_arguments(self):
        model = 'provider/model" -c extra="$(true)'
        endpoint = 'https://example.invalid/proxy/$model;v1'
        for cli in ('codex', 'claude'):
            settings = worker.CliSettings(cli, endpoint, model, 'provider-secret', 'github-secret')
            args, env = worker.cli_command(settings, worker.work_env(Path('/tmp/job')))
            self.assertNotIn(settings.api_key, ' '.join(args))
            self.assertNotIn(settings.github_token, ' '.join(args) + str(env))
            self.assertEqual(args[args.index('-m' if cli == 'codex' else '--model') + 1], model)
            if cli == 'claude':
                self.assertEqual(env['ANTHROPIC_BASE_URL'], endpoint)
                self.assertEqual(env['ANTHROPIC_API_KEY'], settings.api_key)
            else:
                self.assertNotIn('CODEX_API_KEY', env)
                overrides = dict(args[i + 1].split('=', 1) for i, flag in enumerate(args) if flag == '-c')
                prefix = 'model_providers.' + json.loads(overrides['model_provider']) + '.'
                self.assertEqual(json.loads(overrides[prefix + 'base_url']), endpoint)
                self.assertEqual(json.loads(overrides[prefix + 'wire_api']), 'responses')
                env_key = json.loads(overrides[prefix + 'env_key'])
                self.assertEqual(env[env_key], settings.api_key)
                self.assertNotIn(env_key, json.loads(overrides['shell_environment_policy.include_only']))

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
        for secret in (config.key, config.settings.github_token, config.settings.api_key, 'fake-lease'):
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
