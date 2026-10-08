import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  countRegisteredFaucets,
  evmRpc,
  getAccountFrame,
  midenGetAccount,
  parseBridgeConfig,
  parseBridgeConfigDetailed,
  plannedChecks,
  smokeTest,
  switchErrors,
  versionError
} from './validate.mjs';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (dir, name) => JSON.parse(readFileSync(path.join(FIXTURES, dir, name), 'utf8'));
const fixtureNames = dir => readdirSync(path.join(FIXTURES, dir)).filter(name => name.endsWith('.json'));
const testnet = () => readFixture('good', 'testnet-full.json');

describe('fixtures', () => {
  for (const name of fixtureNames('good')) {
    it(`accepts good/${name}`, () => {
      const { config, errors } = parseBridgeConfigDetailed(readFixture('good', name), 'testnet');
      assert.deepEqual(errors, []);
      assert.notEqual(config, null);
      assert.deepEqual(switchErrors(config), []);
    });
  }

  for (const name of fixtureNames('bad')) {
    it(`refuses bad/${name} for its stated reason`, () => {
      const body = readFixture('bad', name);
      const { config, errors } = parseBridgeConfigDetailed(body, 'testnet');
      const reasons = config === null ? errors : switchErrors(config);
      assert.ok(reasons.includes(body._expect), `expected "${body._expect}", got ${JSON.stringify(reasons)}`);
    });
  }
});

describe('parseBridgeConfig', () => {
  it('refuses a body that is not an object', () => {
    for (const body of [null, [], 'testnet', 1]) assert.equal(parseBridgeConfig(body, 'testnet'), null);
  });

  it('lowercases addresses and ids and strips trailing slashes', () => {
    const body = testnet();
    body.epoch.allocatorUrl = 'https://testnet-dev.epochprotocol.xyz//';
    body.agglayer.midenBridge = '0x3B66E20B5088F25133B69216484652';
    const config = parseBridgeConfig(body, 'testnet');
    assert.equal(config.epoch.evmUsdc, '0x2bb4ffd7e2c6d432b697554efd77fa13bdbefd69');
    assert.equal(config.agglayer.midenBridge, '0x3b66e20b5088f25133b69216484652');
    assert.equal(config.epoch.allocatorUrl, 'https://testnet-dev.epochprotocol.xyz');
    assert.equal(config.agglayer.indexerUrl, 'https://miden-testnet-bridge.dev.eu-north-3.gateway.fm/api');
  });

  it('returns a URL as its origin and path, the way the wallet does', () => {
    const body = testnet();
    body.epoch.allocatorUrl = 'https://Testnet-Dev.EpochProtocol.xyz:443/v1//';
    assert.equal(parseBridgeConfig(body, 'testnet').epoch.allocatorUrl, 'https://testnet-dev.epochprotocol.xyz/v1');
  });

  it('accepts local http only when asked to, the way an E2E build does', () => {
    const body = { network: 'localnet', version: 1, epoch: { allocatorUrl: 'http://127.0.0.1:8548' } };
    assert.equal(parseBridgeConfig(body, 'localnet'), null);
    assert.equal(
      parseBridgeConfig(body, 'localnet', { allowLocalHttp: true }).epoch.allocatorUrl,
      'http://127.0.0.1:8548'
    );
    body.epoch.allocatorUrl = 'http://localhost:8548/';
    assert.equal(
      parseBridgeConfig(body, 'localnet', { allowLocalHttp: true }).epoch.allocatorUrl,
      'http://localhost:8548'
    );
    body.epoch.allocatorUrl = 'http://example.com';
    assert.equal(parseBridgeConfig(body, 'localnet', { allowLocalHttp: true }), null);
  });

  it('drops an unsupported chain or protocol instead of refusing the document', () => {
    const { config, dropped } = parseBridgeConfigDetailed(
      readFixture('good', 'testnet-unsupported-values.json'),
      'testnet'
    );
    assert.equal(config.evm.chainId, undefined);
    assert.equal(config.epoch.earnProtocol, undefined);
    assert.equal(dropped.length, 2);
  });

  it('reads a missing switch, or a missing features section, as off', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet');
    assert.deepEqual(config.features, { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: false });
    assert.deepEqual(config.agglayer, { l1Bridge: undefined, midenBridge: undefined, indexerUrl: undefined });
  });

  it('reads a missing mainnetCountdown section as off with no moment', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-minimal.json'), 'testnet');
    assert.deepEqual(config.mainnetCountdown, { enabled: false, launchAt: undefined });
  });

  it('reads the countdown switch and its moment', () => {
    const config = parseBridgeConfig(readFixture('good', 'testnet-countdown.json'), 'testnet');
    assert.deepEqual(config.mainnetCountdown, { enabled: true, launchAt: '2026-10-26T00:00:00Z' });
  });

  it('refuses a countdown moment in any spelling but RFC 3339 UTC', () => {
    for (const launchAt of ['2026-10-26', '2026-10-26T00:00:00+02:00', '2026-10-26 00:00:00Z', 1_792_000_000_000, '2026-13-40T00:00:00Z']) {
      const body = { network: 'testnet', version: 1, mainnetCountdown: { enabled: true, launchAt } };
      const { errors } = parseBridgeConfigDetailed(body, 'testnet');
      assert.ok(errors.some(e => e.startsWith('mainnetCountdown.launchAt must be')), `${launchAt}: ${errors}`);
    }
  });

  it('accepts a countdown moment with fractional seconds', () => {
    const body = { network: 'testnet', version: 1, mainnetCountdown: { enabled: true, launchAt: '2026-10-26T00:00:00.000Z' } };
    assert.equal(parseBridgeConfig(body, 'testnet').mainnetCountdown.launchAt, '2026-10-26T00:00:00.000Z');
  });
});

describe('versionError', () => {
  const base = JSON.stringify({ network: 'testnet', version: 3 });
  it('passes an unchanged file and a new file', () => {
    assert.equal(versionError(base, 3, base), null);
    assert.equal(versionError(base, 1, null), null);
  });
  it('refuses a changed file that keeps or lowers the version', () => {
    const changed = JSON.stringify({ network: 'testnet', version: 3, features: {} });
    assert.match(versionError(changed, 3, base), /greater than 3/);
    assert.match(versionError(changed, 2, base), /greater than 3/);
  });
  it('passes a changed file with a higher version', () => {
    assert.equal(versionError(JSON.stringify({ version: 4 }), 4, base), null);
  });
});

describe('getAccountFrame', () => {
  it('encodes an existence request with empty details', () => {
    assert.equal(
      getAccountFrame('0x3b66e20b5088f25133b69216484652').toString('hex'),
      '00000000150a110a0f3b66e20b5088f25133b692164846521a00'
    );
  });
  it('encodes a whole-map request for one slot', () => {
    assert.equal(
      getAccountFrame('0x3b66e20b5088f25133b69216484652', 'agglayer::bridge::faucet_registry_map').toString('hex'),
      '00000000420a110a0f3b66e20b5088f25133b692164846521a2d222b0a290a256167676c617965723a3a6272696467653a3a6661756365745f72656769737472795f6d61701001'
    );
  });
});

// Independent protobuf writer, so the reader is not checked against itself.
const lengthPrefix = length => (length < 0x80 ? [length] : [(length & 0x7f) | 0x80, length >>> 7]);
const ld = (field, payload) =>
  Buffer.concat([Buffer.from([(field << 3) | 2, ...lengthPrefix(payload.length)]), payload]);
const fixed64 = (field, value) => {
  const out = Buffer.alloc(9);
  out[0] = (field << 3) | 1;
  out.writeBigUInt64LE(value, 1);
  return out;
};
const word = first => Buffer.concat([fixed64(1, first), fixed64(2, 0n), fixed64(3, 0n), fixed64(4, 0n)]);

function registryReply(slot, values, tooMany = false) {
  const entries = Buffer.concat(
    values.map((value, i) => ld(1, Buffer.concat([ld(1, word(BigInt(i + 1))), ld(2, word(value))])))
  );
  const mapBody = tooMany
    ? Buffer.concat([ld(1, Buffer.from(slot)), Buffer.from([0x10, 0x01])])
    : Buffer.concat([ld(1, Buffer.from(slot)), ld(3, entries)]);
  return ld(3, ld(2, ld(2, mapBody)));
}

describe('countRegisteredFaucets', () => {
  const slot = 'agglayer::bridge::faucet_registry_map';
  it('counts entries whose value starts with 1', () => {
    assert.equal(countRegisteredFaucets(registryReply(slot, [1n, 1n, 2n])), 2);
  });
  it('ignores other slots', () => {
    assert.equal(countRegisteredFaucets(registryReply('agglayer::bridge::token_registry_map', [1n])), 0);
  });
  it('refuses a map the node will not return whole', () => {
    assert.throws(() => countRegisteredFaucets(registryReply(slot, [], true)), /too many entries/);
  });
});

function grpcResponse(status, message, { trailer = true, statusMessage = '' } = {}) {
  const frames = [];
  if (message) {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(message.length, 1);
    frames.push(head, message);
  }
  const headers = new Headers({ 'content-type': 'application/grpc-web+proto' });
  if (trailer) {
    const text = Buffer.from(`grpc-status:${status}\r\n`);
    const head = Buffer.alloc(5);
    head[0] = 0x80;
    head.writeUInt32BE(text.length, 1);
    frames.push(head, text);
  } else {
    headers.set('grpc-status', String(status));
    headers.set('grpc-message', encodeURIComponent(statusMessage));
  }
  return new Response(Buffer.concat(frames), { status: 200, headers });
}

describe('midenGetAccount', () => {
  const id = '0x3b66e20b5088f25133b69216484652';
  it('reads a trailer status 0 with a message as found', async () => {
    const reply = await midenGetAccount('https://node', id, undefined, async () =>
      grpcResponse(0, Buffer.from([0x08, 0x01]))
    );
    assert.equal(reply.state, 'ok');
  });
  it('reads the node not-found answer as absent', async () => {
    const reply = await midenGetAccount('https://node', id, undefined, async () =>
      grpcResponse(3, null, { trailer: false, statusMessage: `account ${id} not found at block 693224` })
    );
    assert.equal(reply.state, 'absent');
  });
  it('reads any other status as an error, not as absent', async () => {
    const reply = await midenGetAccount('https://node', id, undefined, async () =>
      grpcResponse(13, null, { trailer: false, statusMessage: 'internal' })
    );
    assert.equal(reply.state, 'error');
  });
});

describe('evmRpc', () => {
  it('falls back to the next RPC when one fails', async () => {
    const seen = [];
    const fetchImpl = async url => {
      seen.push(url);
      if (seen.length === 1) throw new Error('down');
      return Response.json({ jsonrpc: '2.0', id: 1, result: '0xaa36a7' });
    };
    assert.equal(await evmRpc(11155111, 'eth_chainId', [], fetchImpl), '0xaa36a7');
    assert.equal(seen.length, 2);
  });
  it('fails only when every RPC fails', async () => {
    await assert.rejects(
      evmRpc(11155111, 'eth_chainId', [], async () => Response.json({ error: { message: 'no' } })),
      /no RPC/
    );
  });
});

describe('plannedChecks', () => {
  it('plans nothing while every switch is off, so values can be staged', () => {
    assert.deepEqual(plannedChecks(parseBridgeConfig(readFixture('good', 'testnet-staged.json'), 'testnet')), []);
  });
  it('plans only the Agglayer checks for bridge out', () => {
    const config = parseBridgeConfig(testnet(), 'testnet');
    config.features = { earn: false, fastBridge: false, bridgeIn: false, bridgeOut: true };
    const kinds = plannedChecks(config).map(check => check.key);
    assert.ok(kinds.includes('indexer'));
    assert.ok(kinds.includes('l1-network-id'));
    assert.ok(!kinds.includes('allocator'));
  });
});

/** A fake world in which every service and chain answers like testnet does. */
function testnetWorld({ emptyCode = false, allocatorStatus = 'healthy' } = {}) {
  return async (url, init) => {
    const target = String(url);
    if (target.endsWith('/health') && target.includes('positions')) return Response.json({ ok: true });
    if (target.endsWith('/health')) return Response.json({ status: allocatorStatus, allocatorAddresses: {} });
    if (target.endsWith('/healthz')) return Response.json({ status: 'SERVING' });
    if (target.endsWith('/rpc.Api/GetAccount')) {
      return grpcResponse(0, registryReply('agglayer::bridge::faucet_registry_map', [1n]));
    }
    const { method } = JSON.parse(init.body);
    if (method === 'eth_chainId') return Response.json({ result: '0xaa36a7' });
    if (method === 'eth_getCode') return Response.json({ result: emptyCode ? '0x' : '0x6080' });
    return Response.json({ result: `0x${'0'.repeat(62)}12` });
  };
}

describe('smokeTest', () => {
  it('passes every check against a healthy deployment', async () => {
    const results = await smokeTest(parseBridgeConfig(testnet(), 'testnet'), testnetWorld());
    assert.deepEqual(
      results.filter(result => !result.ok),
      []
    );
    assert.equal(results.length, 10);
  });
  it('fails a contract with no code', async () => {
    const results = await smokeTest(parseBridgeConfig(testnet(), 'testnet'), testnetWorld({ emptyCode: true }));
    assert.ok(results.some(result => !result.ok && /has no code/.test(result.detail)));
  });
  it('fails an allocator whose /health does not say healthy', async () => {
    // The wallet's own rule (derive.ts): an object body with status 'healthy'; allocatorAddresses alone is not enough.
    const world = testnetWorld({ allocatorStatus: 'degraded' });
    const results = await smokeTest(parseBridgeConfig(testnet(), 'testnet'), world);
    assert.ok(results.some(result => !result.ok && result.label === 'Epoch allocator'));
  });
});
