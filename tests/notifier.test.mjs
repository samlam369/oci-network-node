import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Execute the actual embedded notifier definitions, never main(), OCI or HTTP.
const template = readFileSync(new URL('../cloud-init/network-node.yaml', import.meta.url), 'utf8');
const section = template.split('  - path: /usr/local/sbin/oci-ready-notify\n')[1]
  .split('\n  - path:')[0].split('    content: |\n')[1];
assert.ok(section);
const source = section.split('\n').map(line => line.startsWith('      ') ? line.slice(6) : line).join('\n');
const harness = `
import json, sys
request = json.load(sys.stdin)
namespace = {'__name__': 'notifier_test'}
exec(compile(request['source'], 'oci-ready-notify', 'exec'), namespace)
try:
    payload = namespace['build_payload'](request['config'], '100.64.0.1', 'node<&>')
    print(json.dumps({'payload': payload}))
except (ValueError, TypeError):
    print(json.dumps({'invalid': True}))
`;
function payload(config) {
  const result = spawnSync('python3', ['-c', harness], {
    input: JSON.stringify({ source, config }), encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('ordinary Telegram chat omits message_thread_id and escapes HTML', () => {
  const result = payload({chatId: '-100123'}).payload;
  assert.equal(result.chat_id, -100123);
  assert.equal(Object.hasOwn(result, 'message_thread_id'), false);
  assert.match(result.text, /node&lt;&amp;&gt;/);
});

test('forum topic accepts positive integer and integer string', () => {
  for (const value of [123, '123']) {
    assert.equal(payload({chatId: '-100123', messageThreadId: value}).payload.message_thread_id, 123);
  }
});

test('explicit invalid topic IDs are rejected rather than silently omitted', () => {
  for (const value of [null, '', 'bad', 0, -1, '0', '-1', true, false, 1.5, [], {}]) {
    assert.deepEqual(payload({chatId: '-100123', messageThreadId: value}), {invalid: true});
  }
});
