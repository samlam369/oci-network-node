import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../scripts/warmup.mjs', import.meta.url);
function run(args, env = {}) {
  return spawnSync(process.execPath, [script.pathname, ...args], {
    encoding: 'utf8', timeout: 3000,
    env: { ...process.env, OCI_NETWORK_NODE_DOMAINS: '/nonexistent/domains.json', ...env },
  });
}

test('help works without domain config or OCI credentials and makes no readiness claim', () => {
  const result = run(['--help'], { RESOLVER: 'invalid-resolver' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DNS answers do not prove App Connector routing/);
  assert.match(result.stdout, /OCI_NETWORK_NODE_DOMAINS/);
});

test('missing config and missing option value fail before DNS', () => {
  assert.equal(run([]).status, 2);
  const result = run(['--domains']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires a JSON file path/);
});

test('malformed or unsafe domain profiles fail before resolver setup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-warmup-'));
  try {
    const path = join(dir, 'domains.json');
    for (const profile of ['{', '{}', '{"domains":[]}', ...[
      'https://example.com', '*.example.com', 'example.com/path', '-bad.example',
      'example..com', '127.0.0.1', '', 42,
    ].map(domain => JSON.stringify({ domains: [domain] }))]) {
      writeFileSync(path, profile);
      const result = run(['--domains', path], { RESOLVER: 'invalid-resolver' });
      assert.equal(result.status, 2, profile);
      assert.match(result.stderr, /Cannot load domains/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('valid domain file from env or CLI reaches resolver setup without network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'node-warmup-'));
  try {
    const path = join(dir, 'domains.json');
    writeFileSync(path, JSON.stringify({ domains: ['Example.com', 'api.example.com'] }));
    for (const [args, env] of [
      [[], { OCI_NETWORK_NODE_DOMAINS: path }],
      [['--domains', path], {}],
    ]) {
      const result = run(args, { ...env, RESOLVER: 'invalid-resolver' });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ERR_INVALID_IP_ADDRESS/);
      assert.doesNotMatch(result.stderr, /Cannot load domains/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
