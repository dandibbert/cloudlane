import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname, inZone, serviceURL, mergeIngress, validateRoute, equal, seal, unseal, summarizeStatus, originOptions, validateSecrets } from '../worker/core.mjs';
import { dnsMatches } from '../worker/cloudflare.mjs';
import { profile, spec, KEY } from './helpers.mjs';

test('domain normalization preserves DNS semantics and IDN', () => { assert.equal(hostname('IMAGE.A.EXAMPLE.'), 'image.a.example'); assert.match(hostname('例子.测试'), /^xn--/); assert.equal(inZone('evil-a.example', 'a.example'), false); assert.equal(inZone('image.a.example', 'a.example'), true); });
for (const value of ['https://example.com', '*.example.com', 'example.com/a', 'example.com:443', '127.0.0.1', 'a..example', '-a.example', 'a.example?x', 'foo@example.com', '%61.example']) test(`reject invalid hostname ${value}`, () => assert.throws(() => hostname(value)));
test('validation record names require explicit underscore authorization', () => { assert.throws(() => hostname('_acme-challenge.x.example')); assert.equal(hostname('_acme-challenge.x.example', true), '_acme-challenge.x.example'); });
test('service accepts HTTP IPv6 and host.docker.internal; rejects non-web or credentials', () => { assert.equal(serviceURL('https://[::1]:8443/'), 'https://[::1]:8443'); assert.equal(serviceURL('http://host.docker.internal:3457'), 'http://host.docker.internal:3457'); for (const v of ['ssh://host:22', 'http://user:pass@host', 'http://host/path', 'http://host/?key=1']) assert.throws(() => serviceURL(v)); });
test('route refuses apex, cross-zone, and a DNS loop', () => { for (const change of [{ publicHostname: 'b.example' }, { publicHostname: 'x.not-b.example' }, { edgeHostname: spec.originHostname }]) assert.throws(() => validateRoute({ ...spec, ...change }, profile)); });
test('ingress merge preserves unrelated fields and inserts before wildcard and catchall', () => {
  const original = { ingress: [{ hostname: '*.a.example', service: 'http://wildcard:80', path: '/foo' }, { hostname: 'ssh.a.example', service: 'ssh://host:22' }, { service: 'http_status:404' }], originRequest: { noTLSVerify: false }, 'warp-routing': { enabled: true } };
  const result = mergeIngress(original, [{ hostname: 'image.a.example', service: 'http://localhost:1111' }]);
  assert.equal(result.ingress[0].hostname, 'image.a.example'); assert.deepEqual(result.ingress.slice(1), original.ingress); assert.deepEqual(result['warp-routing'], original['warp-routing']); assert.equal(original.ingress.length, 3);
});
test('ingress respects exact existing originRequest and preserves unknown rule keys', () => {
  const current = { ingress: [{ hostname: 'image.a.example', service: 'http://host:80', originRequest: { noTLSVerify: true }, future: 'preserve' }, { service: 'http_status:404' }] };
  const updated = mergeIngress(current, [{ hostname: 'image.a.example', service: 'http://host:81' }], true);
  assert.deepEqual(updated.ingress[0].originRequest, current.ingress[0].originRequest); assert.equal(updated.ingress[0].future, 'preserve');
  assert.throws(() => mergeIngress(current, [{ hostname: 'image.a.example', service: 'http://host:81' }]), { code: 'UNMANAGED_CONFLICT' });
});
test('ingress refuses duplicate exact hosts, paths, or missing/misplaced catchall', () => {
  for (const ingress of [[{ hostname: 'image.a.example', path: '/a', service: 'http://host' }, { service: 'http_status:404' }], [{ service: 'http_status:404' }, { hostname: 'x.a.example', service: 'http://host' }], [{ hostname: 'image.a.example', service: 'http://host' }]]) assert.throws(() => mergeIngress({ ingress }, [{ hostname: 'image.a.example', service: 'http://host:81' }], true));
});
test('explicit empty originRequest clears only requested rules; invalid types rejected', () => { assert.throws(() => originOptions({ noTLSVerify: 'true' })); assert.throws(() => originOptions({ httpHostHeader: 'host\r\nevil' })); assert.throws(() => originOptions(JSON.parse('{"__proto__":{}}'))); assert.deepEqual(originOptions({}), {}); });
test('DNS equality handles canonical terminal dots and quoted TXT', () => { assert(dnsMatches({ name: 'x.example', type: 'TXT', content: '"proof"' }, { name: 'x.example', type: 'TXT', content: 'proof' })); assert(dnsMatches({ name: 'X.EXAMPLE', type: 'CNAME', content: 'edge.example.', proxied: false }, { name: 'x.example', type: 'CNAME', content: 'edge.example', proxied: false })); });
test('JSON snapshots compare irrespective of key order', () => assert(equal({ b: 1, a: {} }, { a: {}, b: 1 })));
test('AES-GCM encryption is randomized, authenticated and bound to credential ID', async () => { const a = await seal('secret-token', KEY, 'a'), b = await seal('secret-token', KEY, 'a'); assert.notEqual(a.data, b.data); assert.equal(await unseal(a, KEY, 'a'), 'secret-token'); await assert.rejects(unseal(a, KEY, 'b')); await assert.rejects(unseal({ ...a, data: a.data.slice(0, -4) + 'aaaa' }, KEY, 'a')); });
test('secrets fail closed', async () => { await assert.rejects(validateSecrets({})); await assert.rejects(validateSecrets({ ADMIN_PASSWORD: 'long-enough-password', ENCRYPTION_KEY: 'invalid' })); });
test('pending SSL is informational while drift and offline tunnel still win', () => { const o = { hostnameStatus: 'active', sslStatus: 'pending_validation', tunnelStatus: 'healthy', dnsReady: true }; assert.equal(summarizeStatus(o), 'ready'); assert.equal(summarizeStatus({ ...o, hostnameStatus: 'pending' }), 'pending'); assert.equal(summarizeStatus({ ...o, drift: ['changed'] }), 'drift'); assert.equal(summarizeStatus({ ...o, tunnelStatus: 'down' }), 'offline'); });