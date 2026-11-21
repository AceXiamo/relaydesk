"""Offline integration proof for the Linux image; run via cli-image-proof.sh.

Only the model provider is scripted. The pinned CLIs must execute their real
shell tool, read a random fixture in the sandbox and send its value back.
"""
import json
import re
from pathlib import Path
import secrets
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 18787
URL = f'http://127.0.0.1:{PORT}'
COMMAND = 'cat repo/probe.txt'


class Fixture(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
        codex = self.path.endswith('/responses')
        claude = self.path.split('?')[0].endswith('/messages')
        if not (codex or claude):
            self.send_error(404)
            return
        tool = 'exec_command' if codex else 'Bash'
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def emit(kind, **payload):
            self.wfile.write(f'event: {kind}\ndata: '.encode() + json.dumps({'type': kind, **payload}).encode() + b'\n\n')

        # This value is not in the prompt. It is provided only by the CLI's shell.
        incoming = json.dumps(data.get('input' if codex else 'messages', []))
        found = re.search(r'CLI_PROOF_[0-9a-f]{32}', incoming)
        answer = found.group() if found else None
        if codex:
            resp = {'id': 'resp_fixture', 'object': 'response', 'created_at': 1, 'model': 'fixture', 'output': []}
            emit('response.created', response=dict(resp, status='in_progress'))
            if answer:
                item = {'id': 'msg_1', 'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': answer, 'annotations': []}]}
            else:
                names = [t.get('name') for t in data.get('tools', [])]
                if tool not in names:
                    print('Unexpected shell tool list:', names, flush=True)
                item = {'id': 'fc_1', 'type': 'function_call', 'call_id': 'call_1', 'name': tool, 'arguments': json.dumps({'cmd': COMMAND})}
            emit('response.output_item.added', output_index=0, item=item)
            emit('response.output_item.done', output_index=0, item=item)
            emit('response.completed', response=dict(resp, status='completed', output=[item], usage={'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}))
        else:
            usage = {'input_tokens': 8, 'output_tokens': 4}
            emit('message_start', message={'id': 'msg_fixture', 'role': 'assistant', 'model': data.get('model'), 'type': 'message', 'content': [], 'stop_reason': None, 'stop_sequence': None, 'usage': usage})
            if answer:
                emit('content_block_start', index=0, content_block={'type': 'text', 'text': ''})
                emit('content_block_delta', index=0, delta={'type': 'text_delta', 'text': answer})
            else:
                emit('content_block_start', index=0, content_block={'type': 'tool_use', 'id': 'tool_fixture', 'name': tool, 'input': {}})
                emit('content_block_delta', index=0, delta={'type': 'input_json_delta', 'partial_json': json.dumps({'command': COMMAND, 'description': 'Read fixture'})})
            emit('content_block_stop', index=0)
            emit('message_delta', delta={'stop_reason': 'end_turn' if answer else 'tool_use', 'stop_sequence': None}, usage=usage)
            emit('message_stop')


def proof():
    import time
    import urllib.request
    sys.path.insert(0, '/opt/relaydesk-agent')
    import cli_runner as runner
    runner.sandbox.enable_supervisor()
    for attempt in range(100):
        try:
            with urllib.request.urlopen(URL, timeout=1):
                break
        except OSError:
            time.sleep(.05)
    for cli in ('codex', 'claude'):
        with tempfile.TemporaryDirectory(dir='/tmp') as root:
            work = runner.workspace(Path(root))
            marker = 'CLI_PROOF_' + secrets.token_hex(16)
            probe = work / 'repo/probe.txt'
            probe.write_text(marker)
            probe.chmod(0o444)
            args, env = runner.cli_command(cli, runner.work_env(work), 'fixture-only')
            if cli == 'codex':
                # Set only the test provider; preserve the runner's real tool/sandbox flags.
                env['OPENAI_BASE_URL'] = URL + '/v1'
                args[-1:-1] = ['-c', 'model_provider="fixture"', '-m', 'gpt-5.5', '-c', 'model_providers.fixture.name="fixture"', '-c', f'model_providers.fixture.base_url="{URL}/v1"', '-c', 'model_providers.fixture.wire_api="responses"']
            else:
                env['ANTHROPIC_BASE_URL'] = URL
            started = time.monotonic()

            def timeout():
                if time.monotonic() - started > 30:
                    raise RuntimeError(f'{cli}: offline tool-call proof timed out')

            reply = runner.run_command(args, work, env, work, timeout, prompt=b'Read repo/probe.txt with the shell and report its contents.', stage=cli)
            if marker not in reply:
                raise RuntimeError(f'{cli}: missing shell observation in final reply')
            print(f'OK: {cli} ran its shell tool and returned the fixture.', flush=True)


if __name__ == '__main__':
    if sys.argv[1:] == ['--serve']:
        HTTPServer(('127.0.0.1', PORT), Fixture).serve_forever()
    else:
        proof()
