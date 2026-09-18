import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scripts = fileURLToPath(new URL('../scripts/', import.meta.url));
const cfg = { region: 'test-region-1', compartmentOcid: 'compartment-test', instanceConfigOcid: 'template-test', namePrefix: 'TEST-NODE' };
function run(t, script, args = [], scenario = {}, input = '') {
  const dir = mkdtempSync(join(tmpdir(), 'network-node-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  const config = join(dir, 'config.json');
  const fake = join(dir, 'oci');
  writeFileSync(config, JSON.stringify(cfg));
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(args)+'\\n');
const s = JSON.parse(process.env.FAKE_SCENARIO);
const command = args.slice(0,3).join(' ');
let data;
if (args[0] === '--version') process.exit(0);
if (command === 'bv boot-volume delete' && s.deleteError) { console.error('Permission denied'); process.exit(3); }
switch (command) {
 case 'compute-management instance-configuration get': data = {'instance-details': {'launch-details': {metadata: s.noCloudInit ? {} : {user_data:'test-cloud-init'}}}}; break;
 case 'compute-management instance-configuration launch-compute-instance': data = {id:'instance-created','lifecycle-state': 'RUNNING'}; break;
 case 'compute instance list-vnics': data = [{'public-ip':'192.0.2.12'}]; break;
 case 'compute instance get': data = {'lifecycle-state':'RUNNING'}; break;
 case 'compute instance list': data = s.orphanOnly ? [] : [
  {id:'instance-target','display-name':'TEST-NODE-example','lifecycle-state':'RUNNING'},
  {id:'instance-unrelated','display-name':'OTHER-example','lifecycle-state':'RUNNING'},
  {id:'instance-terminated','display-name':'TEST-NODE-old','lifecycle-state':'TERMINATED'}]; break;
 case 'iam availability-domain list': data = [{name:'test-ad'}]; break;
 case 'bv boot-volume list': data = [
  {id:'volume-orphan','display-name':'TEST-NODE-orphan','lifecycle-state':'AVAILABLE'},
  ...['ATTACHED','ATTACHING','DETACHING'].map(state => ({id:'volume-'+state,'display-name':'TEST-NODE-'+state,'lifecycle-state':'AVAILABLE'})),
  {id:'volume-unrelated','display-name':'OTHER-volume','lifecycle-state':'AVAILABLE'},
  {id:'volume-creating','display-name':'TEST-NODE-creating','lifecycle-state':'PROVISIONING'}]; break;
 case 'compute boot-volume-attachment list': data = ['ATTACHED','ATTACHING','DETACHING'].map(state => ({'boot-volume-id':'volume-'+state,'lifecycle-state':state})); break;
 case 'compute instance terminate':
 case 'bv boot-volume delete': process.exit(0);
 default: console.error('Unexpected mocked command: '+command); process.exit(9);
}
console.log(JSON.stringify({data}));
`, { mode: 0o755 });
  const result = spawnSync(process.execPath, [join(scripts, script + '.mjs'), ...args], {
    encoding: 'utf8', input, timeout: 15000,
    env: { ...process.env, OCI_NETWORK_NODE_CONFIG: config, OCI_NETWORK_NODE_OCI_BIN: fake, FAKE_LOG: log, FAKE_SCENARIO: JSON.stringify(scenario) },
  });
  assert.ifError(result.error);
  return { ...result, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [] };
}
const command = call => call.slice(0, 3).join(' ');
const mutations = calls => calls.filter(c => /launch-compute-instance|terminate|delete/.test(command(c)));
const option = (call, flag) => call[call.indexOf(flag) + 1];
function succeeds(r) { assert.equal(r.status, 0, r.stderr || r.stdout); }

for (const script of ['launch', 'teardown']) {
  test(`${script} help exits without invoking OCI`, t => {
    const r = run(t, script, ['--help']); succeeds(r);
    assert.match(r.stdout, /usage/i); assert.deepEqual(r.calls, []);
  });
  test(`${script} rejects unknown options before invoking OCI`, t => {
    const r = run(t, script, ['--definitely-invalid']);
    assert.notEqual(r.status, 0); assert.deepEqual(r.calls, []);
  });
}
test('launch refuses a template without cloud-init', t => {
  const r = run(t, 'launch', [], {noCloudInit:true});
  assert.notEqual(r.status, 0); assert.match(r.stderr, /cloud-init|user_data/i);
  assert.deepEqual(mutations(r.calls), []);
});
test('launch dry-run validates only the template and launches nothing', t => {
  const r = run(t, 'launch', ['--dry-run']); succeeds(r);
  assert.deepEqual(r.calls.filter(c => c[0] !== '--version').map(command), ['compute-management instance-configuration get']);
});
test('launch overrides displayName only and pins region and template', t => {
  const r = run(t, 'launch'); succeeds(r);
  const call = r.calls.find(c => command(c).endsWith('launch-compute-instance'));
  assert.ok(call);
  const details = JSON.parse(option(call, '--launch-details'));
  assert.deepEqual(Object.keys(details), ['displayName']);
  assert.match(details.displayName, /^TEST-NODE-\d{4}-\d{4}$/);
  assert.equal(option(call, '--instance-configuration-id'), cfg.instanceConfigOcid);
  assert.equal(option(call, '--region'), cfg.region);
});
test('launch wait reports the RUNNING instance public IP', t => {
  const r = run(t, 'launch', ['--wait']); succeeds(r);
  assert.match(r.stdout, /RUNNING/); assert.match(r.stdout, /192\.0\.2\.12/);
  assert.ok(r.calls.some(c => command(c) === 'compute instance list-vnics'));
});
test('teardown dry-run lists instances and volumes without mutation', t => {
  const r = run(t, 'teardown', ['--dry-run']); succeeds(r);
  assert.deepEqual(mutations(r.calls), []);
  assert.ok(r.calls.some(c => command(c) === 'bv boot-volume list'));
  assert.match(r.stdout, /TEST-NODE-orphan/);
});
test('teardown yes affects only matching live instances and detached volumes', t => {
  const r = run(t, 'teardown', ['--yes']); succeeds(r);
  const writes = mutations(r.calls);
  assert.equal(writes.length, 2);
  assert.equal(option(writes.find(c => command(c) === 'compute instance terminate'), '--instance-id'), 'instance-target');
  assert.equal(option(writes.find(c => command(c) === 'compute instance terminate'), '--preserve-boot-volume'), 'false');
  assert.equal(option(writes.find(c => command(c) === 'bv boot-volume delete'), '--boot-volume-id'), 'volume-orphan');
  for (const c of r.calls.filter(c => c[0] !== '--version')) assert.equal(option(c, '--region'), cfg.region);
  for (const c of r.calls.filter(c => c[2] === 'list')) assert.equal(option(c, '--compartment-id'), cfg.compartmentOcid);
  for (const name of ['compute instance list', 'bv boot-volume list', 'compute boot-volume-attachment list']) {
    const lists = r.calls.filter(c => command(c) === name); assert.ok(lists.length);
    for (const c of lists) assert.ok(c.includes('--all'), name + ' must paginate');
  }
});
test('orphan-only teardown asks for confirmation and cancels on no', t => {
  const r = run(t, 'teardown', [], {orphanOnly:true}, 'no\n'); succeeds(r);
  assert.match(r.stdout, /yes.*confirm|confirm.*yes/i);
  assert.match(r.stdout, /cancel/i); assert.deepEqual(mutations(r.calls), []);
});

test('non-benign orphan deletion failure returns a failing status', t => {
  const r = run(t, 'teardown', ['--yes'], {orphanOnly: true, deleteError: true});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Permission denied/);
  assert.doesNotMatch(r.stdout, /✔ Teardown complete/);
});
