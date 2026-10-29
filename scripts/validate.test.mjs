import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  EVM_RPCS,
  MAX_EARN_VAULT_LOGO_BYTES,
  earnLogoErrors,
  evmRpc,
  parseBridgeConfig,
  parseBridgeConfigDetailed,
  main,
  publishedGuardianEndpoints,
  validateFile,
  duplicateKeys,
  plannedChecks,
  smokeTest,
  versionError,
  warningAnnotation,
} from "./validate.mjs";
const source = JSON.parse(
  readFileSync(new URL("../testnet.json", import.meta.url)),
);
const copy = () => structuredClone(source);
// The route and service checks alone: the Guardian checks have their own tests below.
const withoutGuardians = () => {
  const body = copy();
  delete body.guardians;
  return body;
};
const errors = (body) => parseBridgeConfigDetailed(body, "testnet").errors;
test("published documents use the new schema", async () => {
  for (const file of ["testnet.json", "devnet.json", "mainnet.json"])
    assert.deepEqual((await validateFile(file, { smoke: false })).errors, []);
});
test("bad route data rejects the document", async (t) => {
  const cases = [
    (b) => {
      b.supportedEvmChains.sepolia.chainId = 1;
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.epoch.depositEnabled = "true";
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.epoch.tokens.USDC.outputs = [
        "missing",
      ];
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.usdcx.deposit.executorChain =
        "missing";
    },
    (b) => {
      delete b.supportedEvmChains["arc-testnet"].bridges.usdcx.executor;
    },
    (b) => {
      b["bridge-providers"].epoch.allocatorUrl = "http://example.com";
    },
    (b) => {
      b["bridge-providers"].usdcx.midenDomain = -1;
    },
    (b) => {
      delete b["bridge-providers"].agglayer;
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.usdcx.deposit = null;
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.usdcx.tokens.USDC.contractAddress =
        "0x1";
    },
    (b) => {
      b.version = 0;
    },
    (b) => {
      b.network = "devnet";
    },
    (b) => {
      b.onboarding.inviteOnly = "yes";
    },
    (b) => {
      b.limits = { bridgeInMaxBalanceUsd: "1232.462" };
    },
    (b) => {
      b.limits = { bridgeInMaxBalanceUsd: 0 };
    },
    (b) => {
      b.swap.tokens[0].decimals = 1.5;
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.agglayer.tokens = [];
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.agglayer.tokens.USDC.contractAddress =
        "0x1";
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.agglayer.tokens["usdc.e"] = {
        contractAddress: "0x0000000000000000000000000000000000000001",
      };
    },
    (b) => {
      const tokens = b.supportedEvmChains.sepolia.bridges.agglayer.tokens;
      tokens.USDT = { contractAddress: tokens.USDC.contractAddress };
    },
    (b) => {
      b.supportedEvmChains.sepolia.bridges.agglayer.tokenApiUrl =
        "http://eth-sepolia.blockscout.com/api/v2";
    },
  ];
  for (const [index, change] of cases.entries())
    await t.test(`rejects route mutation ${index + 1}`, () => {
      const body = copy();
      change(body);
      assert.ok(errors(body).length > 0);
    });
});
test("Agglayer tokens are optional and each one is probed", () => {
  const body = copy();
  const agglayer = body.supportedEvmChains.sepolia.bridges.agglayer;
  const listed = Object.values(agglayer.tokens).map((token) =>
    token.contractAddress.toLowerCase(),
  );
  const planned = plannedChecks(body).filter(
    (check) =>
      check.address !== undefined &&
      listed.includes(check.address.toLowerCase()),
  );
  for (const kind of ["evm-code", "evm-uint"])
    assert.equal(
      planned.filter((check) => check.kind === kind).length,
      listed.length,
    );
  delete agglayer.tokens;
  assert.deepEqual(errors(body), []);
});
test("mainnet Epoch does not need a testnet faucet or market", () => {
  const body = copy();
  delete body["bridge-providers"].epoch.outputs;
  delete body.supportedEvmChains.sepolia.bridges.epoch.tokens.USDC.outputs;
  assert.deepEqual(errors(body), []);
});
test("geo rules name a feature and a place", () => {
  const body = copy();
  body.geo = {
    earn: { "block NY state": "yes", "block UK": "yes", "block US-CA": "no" },
    swap: { "block DE": "no" },
  };
  assert.deepEqual(errors(body), []);
  body.geo.earn["block New York"] = "yes";
  assert.ok(errors(body).some((error) => error.includes("names US-NY twice")));
  body.geo = { bridgeIn: { "block UK": "yes" } };
  assert.ok(errors(body).some((error) => error.includes("geo.bridgeIn is not a feature")));
  body.geo = { earn: { "block Narnia": "yes" } };
  assert.ok(errors(body).some((error) => error.includes("is not a place")));
  body.geo = { earn: { "block UK": true } };
  assert.ok(errors(body).some((error) => error.includes('must be "yes" or "no"')));
});
test("geo remains optional", () => {
  const body = copy();
  delete body.geo;
  assert.deepEqual(errors(body), []);
});
test("geo rejects inherited alias names", async (t) => {
  for (const feature of ["earn", "swap"])
    for (const place of ["constructor", "__proto__"])
      await t.test(`${feature}: ${place}`, () => {
        const body = copy();
        body.geo = { [feature]: { [`block ${place}`]: "yes" } };
        assert.ok(errors(body).some((error) => error.includes("is not a place")));
      });
});
test("geo rejects repeated raw keys before JSON loses them", async (t) => {
  const body = copy();
  delete body.geo;
  const prefix = JSON.stringify(body).slice(0, -1);
  const cases = [
    ['"geo":{},"geo":{"earn":{"block UK":"no"}}', "document repeats geo"],
    ['"geo":{"earn":{"block UK":"yes"},"earn":{"block UK":"no"}}', "geo repeats earn"],
    ['"geo":{"swap":{"block UK":"yes"},"swap":{"block UK":"no"}}', "geo repeats swap"],
    ['"geo":{"earn":{"block UK":"yes","block UK":"no"}}', "geo.earn repeats block UK"],
    ['"geo":{"swap":{"block UK":"yes","block UK":"no"}}', "geo.swap repeats block UK"],
    ['"geo":{"wallet":{"block CU":"yes","block CU":"no"}}', "geo.wallet repeats block CU"],
  ];
  const root = mkdtempSync(path.join(tmpdir(), "config-geo-test-"));
  try {
    for (const [section, expected] of cases)
      await t.test(expected, async () => {
        writeFileSync(path.join(root, "testnet.json"), `${prefix},${section}}`);
        const result = await validateFile("testnet.json", { root, smoke: false });
        assert.ok(result.errors.includes(expected), JSON.stringify(result.errors));
      });
    writeFileSync(
      path.join(root, "testnet.json"),
      `${prefix},"geo":{"earn":{"block UK":"yes"},"swap":{"block UK":"no"}}}`,
    );
    assert.deepEqual((await validateFile("testnet.json", { root, smoke: false })).errors, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("published global wallet policy blocks every required jurisdiction", () => {
  const expected = Object.fromEntries(
    ["CU", "IR", "KP", "RU", "BY", "UA-43", "UA-40", "UA-14", "UA-09", "UA-65", "UA-23"]
      .map((place) => [`block ${place}`, "yes"]),
  );
  for (const file of ["testnet.json", "devnet.json", "mainnet.json"]) {
    const body = JSON.parse(readFileSync(new URL(`../${file}`, import.meta.url)));
    assert.deepEqual(body.geo?.wallet, expected, file);
    assert.deepEqual(body.geo?.earn, { "block NY state": "yes", "block UK": "yes" }, file);
  }
});
test("geo wallet rules use the same validated place grammar", () => {
  const body = copy();
  body.geo = { wallet: { "block CU": "yes", "block UA-43": "yes" } };
  assert.deepEqual(errors(body), []);
  body.geo.wallet["block __proto__"] = "yes";
  assert.ok(errors(body).some((error) => error.includes("is not a place")));
});
test("raw duplicate results stay unique across repeated keys and objects", () => {
  for (const target of [[], ["geo"], ["geo", "wallet"], ["geo", "earn"], ["geo", "swap"], ["supportedEvmChains"]]) {
    const wrap = (value) => target.reduceRight((text, key) => `{${JSON.stringify(key)}:${text}}`, value);
    const first = wrap('{"b":0,"a":0,"b":1,"b":2}');
    const second = wrap('{"a":0,"a":1,"b":0,"b":1}');
    assert.deepEqual(duplicateKeys(first, target), ["b"]);
    assert.deepEqual(duplicateKeys(`{${first.slice(1, -1)},${second.slice(1, -1)}}`, target), ["b", "a"]);
  }
});
test("raw duplicate scans remain bounded for large geo objects", async (t) => {
  const keys = Array.from({ length: 100000 }, (_, index) =>
    `block ${String.fromCharCode(65 + Math.floor(index / 46656))}A-${(index % 46656).toString(36).padStart(3, "0")}`,
  );
  const entries = keys.flatMap((key) => [`${JSON.stringify(key)}:"yes"`, `${JSON.stringify(key)}:"no"`]).join(",");
  for (const target of [["geo", "earn"], ["geo", "swap"], ["supportedEvmChains"]])
    await t.test(target.join("."), () => {
      const text = target.reduceRight((value, key) => `{${JSON.stringify(key)}:${value}}`, `{${entries}}`);
      const start = performance.now();
      const duplicates = duplicateKeys(text, target);
      const elapsed = performance.now() - start;
      assert.deepEqual(duplicates, keys);
      assert.ok(elapsed < 5000, `duplicate scan exceeded5000ms: ${Math.round(elapsed)}ms`);
    });
});
test("executor target can have both new-start controls off", () => {
  const body = copy();
  const target = body.supportedEvmChains["arc-testnet"].bridges.usdcx;
  target.depositEnabled = false;
  target.withdrawalEnabled = false;
  assert.deepEqual(errors(body), []);
  assert.ok(
    plannedChecks(body).some(
      (check) => check.address === target.executor.address,
    ),
  );
});
test("duplicate chain keys are detected before JSON loses them", async () => {
  assert.deepEqual(
    duplicateKeys('{"supportedEvmChains":{"sepolia":{},"sepolia":{}}}', [
      "supportedEvmChains",
    ]),
    ["sepolia"],
  );
  const root = mkdtempSync(path.join(tmpdir(), "config-test-"));
  writeFileSync(
    path.join(root, "testnet.json"),
    '{"network":"testnet","version":1,"supportedEvmChains":{"sepolia":{"chainId":11155111,"bridges":{}},"sepolia":{"chainId":11155111,"bridges":{}}}}',
  );
  assert.ok(
    (await validateFile("testnet.json", { root, smoke: false })).errors.some(
      (error) => error.includes("repeats"),
    ),
  );
});
test("smoke checks use the route chain and skip disabled routes", async () => {
  const body = withoutGuardians();
  body.features.earn = false;
  for (const chain of Object.values(body.supportedEvmChains))
    for (const bridge of Object.values(chain.bridges)) {
      bridge.depositEnabled = false;
      bridge.withdrawalEnabled = false;
    }
  assert.deepEqual(plannedChecks(body), []);
  body.supportedEvmChains["base-sepolia"].bridges.usdcx.withdrawalEnabled =
    true;
  assert.ok(plannedChecks(body).every((check) => check.chainId === 84532));
  const result = await smokeTest(body, async (url, init) => ({
    status: 200,
    json: async () => ({
      result:
        JSON.parse(init.body).method === "eth_chainId" ? "0x14a34" : "0x1234",
    }),
  }));
  assert.ok(result.every((check) => check.ok));
});
test("changed documents require a higher version", () => {
  assert.ok(versionError("changed", 7, '{"version":7}'));
  assert.equal(versionError("changed", 8, '{"version":7}'), null);
});

test("rejects migrated invalid fixtures", async (t) => {
  const root = new URL("./fixtures/bad/", import.meta.url);
  for (const name of readdirSync(root)) {
    const body = JSON.parse(readFileSync(new URL(name, root)));
    const dir = mkdtempSync(path.join(tmpdir(), "config-regression-"));
    writeFileSync(path.join(dir, "testnet.json"), JSON.stringify(body));
    await t.test(name, async () =>
      assert.ok(
        (await validateFile("testnet.json", { root: dir, smoke: false })).errors
          .length > 0,
        name,
      ),
    );
  }
});

test("accepts migrated valid fixtures", async (t) => {
  const root = new URL("./fixtures/good/", import.meta.url);
  for (const name of readdirSync(root)) {
    const body = JSON.parse(readFileSync(new URL(name, root)));
    const dir = mkdtempSync(path.join(tmpdir(), "config-regression-"));
    writeFileSync(path.join(dir, "testnet.json"), JSON.stringify(body));
    await t.test(name, async () =>
      assert.deepEqual(
        (await validateFile("testnet.json", { root: dir, smoke: false }))
          .errors,
        [],
        name,
      ),
    );
  }
});

test("smoke checks report contract and service failures", async (t) => {
  for (const scenario of [
    "empty code",
    "wrong chain",
    "bad uint",
    "HTTP failure",
    "bad health",
    "invalid JSON",
    "RPC error",
    "fetch error",
  ]) {
    await t.test(scenario, async () => {
      const results = await smokeTest(withoutGuardians(), async (url, init) => {
        if (scenario === "fetch error") throw new Error("offline");
        if (init.method !== "POST")
          return {
            status: scenario === "HTTP failure" ? 503 : 200,
            json: async () => {
              if (scenario === "invalid JSON") throw new Error("not JSON");
              return scenario === "bad health"
                ? {}
                : {
                    status: url.includes("healthz") ? "SERVING" : "healthy",
                    ok: true,
                  };
            },
          };
        const request = JSON.parse(init.body);
        let result;
        switch (request.method) {
          case "eth_chainId":
            result =
              scenario === "wrong chain"
                ? "0x1"
                : `0x${Number(Object.entries({ "rpc.testnet.arc.io": 5042002, "sepolia.base.org": 84532, "sepolia-rollup.arbitrum.io": 421614 }).find(([host]) => url.includes(host))?.[1] ?? 11155111).toString(16)}`;
            break;
          case "eth_call":
            result = scenario === "bad uint" ? "0x1" : `0x${"0".repeat(63)}6`;
            break;
          default:
            result = scenario === "empty code" ? "0x" : "0x1234";
        }
        return {
          status: 200,
          json: async () =>
            scenario === "RPC error"
              ? { error: { message: "unavailable" } }
              : { result },
        };
      });
      assert.ok(results.some((result) => !result.ok));
    });
  }
});

test("preserves the published feature keys and validates their boolean values", () => {
  assert.deepEqual(source.features, {
    earn: true,
    fastBridge: true,
    bridgeIn: true,
    bridgeOut: true,
    encryptedBackup: false,
  });
  for (const name of Object.keys(source.features)) {
    const body = copy();
    body.features[name] = false;
    // The Earn vaults exist only while Earn is on.
    if (name === "earn") delete body.earn;
    const result = parseBridgeConfigDetailed(body, "testnet");
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.features[name], false);
    body.features[name] = "true";
    assert.ok(errors(body).some(error => error.includes(`features.${name}`)));
  }
});

test("the Arcade GC sale exists exactly while its switch is on and names the seller", () => {
  const mainnet = JSON.parse(
    readFileSync(new URL("../mainnet.json", import.meta.url)),
  );
  const parsed = parseBridgeConfigDetailed(mainnet, "mainnet");
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.config.features.arcadeGcPurchase, true);
  assert.deepEqual(parsed.config.arcade, {
    sale: { seller: "0xa6be5c4d8fdc03415bde66453d5f91" },
  });

  const off = copy();
  assert.equal(
    parseBridgeConfigDetailed(off, "testnet").config.features.arcadeGcPurchase,
    false,
  );
  off.arcade = { sale: { seller: "0xa6be5c4d8fdc03415bde66453d5f91" } };
  assert.ok(errors(off).some((error) => error.includes("arcade must be omitted")));

  const on = copy();
  on.features.arcadeGcPurchase = true;
  assert.ok(errors(on).some((error) => error.includes("arcade.sale is required")));
  on.arcade = { sale: {} };
  assert.ok(errors(on).some((error) => error.includes("arcade.sale.seller is required")));
  on.arcade = { sale: { seller: "mm1azntuhzd3lwqxs2mmeny202ljy3fxnpm" } };
  assert.ok(errors(on).some((error) => error.includes("arcade.sale.seller")));
  on.arcade = { sale: { seller: "0xa6be5c4d8fdc03415bde66453d5f91" } };
  assert.deepEqual(errors(on), []);
  on.features.arcadeGcPurchase = "true";
  assert.ok(errors(on).some((error) => error.includes("features.arcadeGcPurchase")));
});

test("the encrypted backup section exists exactly while its switch is on", async (t) => {
  const BACKUP = "https://backup.miden.example";
  const withBackup = (backup) => {
    const body = copy();
    body.features.encryptedBackup = true;
    if (backup !== undefined) body.backup = backup;
    return body;
  };

  await t.test("the published mainnet document names the live service; testnet and devnet stay off", () => {
    const mainnet = JSON.parse(
      readFileSync(new URL("../mainnet.json", import.meta.url)),
    );
    assert.equal(mainnet.features.encryptedBackup, true);
    assert.deepEqual(mainnet.backup, {
      baseUrl: "https://miden-wallet-api.utkarsh-s.workers.dev",
    });
    for (const network of ["testnet", "devnet"]) {
      const body = JSON.parse(
        readFileSync(new URL(`../${network}.json`, import.meta.url)),
      );
      assert.equal(body.features.encryptedBackup, false, network);
      assert.equal(body.backup, undefined, network);
    }
  });

  await t.test("on with a valid section passes", () => {
    const parsed = parseBridgeConfigDetailed(withBackup({ baseUrl: BACKUP }), "testnet");
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.config.features.encryptedBackup, true);
    assert.deepEqual(parsed.config.backup, { baseUrl: BACKUP });
    const withPath = parseBridgeConfigDetailed(
      withBackup({ baseUrl: `${BACKUP}/v1` }),
      "testnet",
    );
    assert.deepEqual(withPath.errors, []);
    assert.deepEqual(withPath.config.backup, { baseUrl: `${BACKUP}/v1` });
  });

  await t.test("on with the section missing fails", () => {
    assert.ok(
      errors(withBackup()).some((error) =>
        error.includes("backup.baseUrl is required while features.encryptedBackup is on"),
      ),
    );
    assert.ok(
      errors(withBackup({})).some((error) => error.includes("backup.baseUrl is required")),
    );
    assert.ok(errors(withBackup("x")).some((error) => error.includes("backup must be an object")));
  });

  await t.test("off with the section present fails", () => {
    const off = copy();
    off.backup = { baseUrl: BACKUP };
    assert.ok(errors(off).some((error) => error.includes("backup must be omitted")));
    const absent = copy();
    delete absent.features.encryptedBackup;
    absent.backup = { baseUrl: BACKUP };
    assert.ok(errors(absent).some((error) => error.includes("backup must be omitted")));
  });

  await t.test("an absent switch means off", () => {
    const body = copy();
    delete body.features.encryptedBackup;
    const parsed = parseBridgeConfigDetailed(body, "testnet");
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.config.features.encryptedBackup, false);
    assert.equal(parsed.config.backup, undefined);
  });

  await t.test("the switch accepts only a boolean", () => {
    const body = withBackup({ baseUrl: BACKUP });
    body.features.encryptedBackup = "true";
    assert.ok(
      errors(body).some((error) => error.includes("features.encryptedBackup must be boolean")),
    );
  });

  await t.test("a bad base URL fails", () => {
    for (const [baseUrl, reason] of [
      ["http://backup.miden.example", "must use https:"],
      ["http://127.0.0.1:8787", "must use https:"],
      [`${BACKUP}/`, "must not end with a slash"],
      [`${BACKUP}/v1/`, "must not end with a slash"],
      [`${BACKUP}?token=1`, "a query or a fragment"],
      [`${BACKUP}?`, "a query or a fragment"],
      [`${BACKUP}#entries`, "a query or a fragment"],
      ["https://user:secret@backup.miden.example", "credentials"],
      ["backup.miden.example", "is not a URL"],
      [42, "must be a URL string"],
    ]) {
      assert.ok(
        errors(withBackup({ baseUrl })).some(
          (error) => error.startsWith("backup.baseUrl") && error.includes(reason),
        ),
        String(baseUrl),
      );
    }
  });
});

test("nearIntents defaults off and accepts only explicit booleans", () => {
  const body = copy();
  delete body.features.nearIntents;
  assert.equal(
    parseBridgeConfigDetailed(body, "testnet").config.features.nearIntents,
    false,
  );
  for (const value of [false, true]) {
    body.features.nearIntents = value;
    const result = parseBridgeConfigDetailed(body, "testnet");
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.features.nearIntents, value);
  }
  body.features.nearIntents = "true";
  assert.ok(
    errors(body).some((error) =>
      error.includes("features.nearIntents must be boolean"),
    ),
  );
});

const FIXTURES = new URL("./fixtures/", import.meta.url);
const readFixture = (kind, name) =>
  JSON.parse(readFileSync(new URL(`${kind}/${name}`, FIXTURES)));
const OZ = "https://guardian-testnet.openzeppelin.com";
const KODA = "https://guardian-testnet.kodax.com";
const commitmentOf = (digit) => `0x${digit.repeat(64)}`;

/** A fake world in which each Guardian answers `GET /pubkey` with what `answers` holds for its origin. */
function guardianWorld(answers) {
  return async (url) => {
    const { origin, pathname, search } = new URL(String(url));
    assert.equal(pathname + search, "/pubkey?scheme=ecdsa");
    const answer = answers[origin];
    if (answer === undefined) throw new Error("unreachable");
    return typeof answer === "number"
      ? new Response("down", { status: answer })
      : Response.json(answer);
  };
}

const guardianFixture = () =>
  parseBridgeConfig(readFixture("good", "testnet-guardians.json"), "testnet");
const healthyGuardians = {
  [OZ]: { commitment: commitmentOf("a") },
  [KODA]: { commitment: commitmentOf("b") },
};
const withGuardians = (guardians) => ({
  network: "testnet",
  version: 1,
  guardians,
});
const guardianEntry = (index) => ({
  id: `operator-${index}`,
  name: "Operator",
  operatedBy: "Operator",
  location: "EU",
  endpoint: `https://guardian-${index}.example.com`,
});

test("reads no Guardian list from a document that has none, so the wallet keeps its own", () => {
  const config = parseBridgeConfig(
    readFixture("good", "testnet-minimal.json"),
    "testnet",
  );
  assert.equal("guardians" in config, false);
});

test("reads the Guardian list in document order with endpoints in the wallet form", () => {
  const body = readFixture("good", "testnet-guardians.json");
  body.guardians[0].endpoint = `${OZ}/`;
  body.guardians[1].endpoint = "https://GUARDIAN-testnet.kodax.com:443//";
  assert.deepEqual(parseBridgeConfig(body, "testnet").guardians, [
    {
      id: "open-zeppelin",
      name: "OpenZeppelin",
      operatedBy: "OpenZeppelin",
      location: "US-EAST",
      endpoint: OZ,
    },
    {
      id: "kodax",
      name: "Koda",
      operatedBy: "Korea Digital Asset (Koda)",
      location: "Asia (SK)",
      endpoint: KODA,
    },
  ]);
});

test("refuses a Guardian list above the limit, a long id, a long label and a control character", () => {
  const parse = (guardians) =>
    parseBridgeConfig(withGuardians(guardians), "testnet");
  const many = (length) =>
    Array.from({ length }, (_, index) => guardianEntry(index));
  assert.notEqual(parse(many(16)), null);
  assert.equal(parse(many(17)), null);
  assert.equal(parse([{ ...guardianEntry(0), id: "a".repeat(33) }]), null);
  assert.equal(parse([{ ...guardianEntry(0), id: "a--b" }]), null);
  assert.equal(parse([{ ...guardianEntry(0), id: "no-guardian" }]), null);
  assert.equal(parse([{ ...guardianEntry(0), name: "n".repeat(49) }]), null);
  assert.equal(
    parse([{ ...guardianEntry(0), operatedBy: "Line\nbreak" }]),
    null,
  );
  assert.equal(parse([{ ...guardianEntry(0), location: 7 }]), null);
  assert.equal(parse(["https://guardian.example.com"]), null);
});

test("reads a Guardian's English about and kind as written, and leaves them out when absent", () => {
  const described = {
    ...guardianEntry(0),
    about: "A smart contract security company.",
    kind: "Smart contract security",
  };
  assert.deepEqual(
    parseBridgeConfig(withGuardians([described, guardianEntry(1)]), "testnet")
      .guardians,
    [described, guardianEntry(1)],
  );
});

test("refuses a Guardian about or kind that is not one line of English text within its limit", () => {
  const parse = (fields) =>
    parseBridgeConfig(
      withGuardians([{ ...guardianEntry(0), ...fields }]),
      "testnet",
    );
  assert.notEqual(parse({ about: "a".repeat(160), kind: "k".repeat(64) }), null);
  assert.equal(parse({ about: "a".repeat(161) }), null);
  assert.equal(parse({ kind: "k".repeat(65) }), null);
  assert.equal(parse({ about: "" }), null);
  assert.equal(parse({ about: { en: "A security company." } }), null);
  assert.equal(parse({ about: "Line\nbreak" }), null);
  assert.equal(parse({ kind: " Padded" }), null);
  assert.equal(parse({ kind: 7 }), null);
});

test("accepts a local http Guardian endpoint only when the caller allows it", () => {
  const body = readFixture("good", "testnet-guardians.json");
  body.guardians[0].endpoint = "http://localhost:3000";
  assert.equal(parseBridgeConfig(body, "testnet"), null);
  const config = parseBridgeConfig(body, "testnet", { allowLocalHttp: true });
  assert.equal(config.guardians[0].endpoint, "http://localhost:3000");
});

test("plans one Guardian check per operator with every switch off", () => {
  assert.deepEqual(
    plannedChecks(guardianFixture()).map(({ key, url, advisory }) => ({
      key,
      url,
      advisory,
    })),
    [
      {
        key: `guardian:${OZ}`,
        url: `${OZ}/pubkey?scheme=ecdsa`,
        advisory: false,
      },
      {
        key: `guardian:${KODA}`,
        url: `${KODA}/pubkey?scheme=ecdsa`,
        advisory: false,
      },
    ],
  );
});

test("makes the check of an operator the base already lists advisory", () => {
  const checks = plannedChecks(guardianFixture(), { publishedGuardians: [OZ] });
  assert.deepEqual(
    checks.map((check) => check.advisory),
    [true, false],
  );
});

test("passes Guardian operators that each serve their own key commitment", async () => {
  const results = await smokeTest(
    guardianFixture(),
    guardianWorld(healthyGuardians),
  );
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true],
  );
});

test("fails a Guardian operator that is down, answers no commitment or answers a malformed one", async () => {
  for (const answer of [
    503,
    undefined,
    {},
    { commitment: "0x1234" },
    { commitment: 1234 },
    [],
  ]) {
    const results = await smokeTest(
      guardianFixture(),
      guardianWorld({ ...healthyGuardians, [KODA]: answer }),
    );
    assert.deepEqual(
      results.map((result) => result.ok),
      [true, false],
      JSON.stringify(answer),
    );
  }
});

test("fails the second of two Guardian operators that serve one key commitment, whatever the base lists", async () => {
  const world = guardianWorld({
    ...healthyGuardians,
    [KODA]: { commitment: commitmentOf("A") },
  });
  const results = await smokeTest(guardianFixture(), world, {
    publishedGuardians: [OZ, KODA],
  });
  assert.equal(results[1].ok, false);
  assert.equal(results[1].advisory, false);
  assert.match(
    results[1].detail,
    /serves the key commitment Guardian open-zeppelin serves/,
  );
});

test("reads the Guardian endpoints the base document lists, and none from a base without a usable list", () => {
  const base = JSON.stringify(readFixture("good", "testnet-guardians.json"));
  assert.deepEqual(publishedGuardianEndpoints(base, "testnet"), [OZ, KODA]);
  assert.deepEqual(publishedGuardianEndpoints(null, "testnet"), []);
  assert.deepEqual(publishedGuardianEndpoints("not json", "testnet"), []);
  assert.deepEqual(
    publishedGuardianEndpoints(
      JSON.stringify({ network: "testnet", version: 1 }),
      "testnet",
    ),
    [],
  );
  assert.deepEqual(publishedGuardianEndpoints(base, "devnet"), []);
});

/** The Guardian fixture as the document of `network`. */
const guardianDocument = (network) => ({
  ...readFixture("good", "testnet-guardians.json"),
  network,
});
const KODA_DOWN = `Guardian kodax: ${KODA}/pubkey?scheme=ecdsa answered HTTP 503`;
const kodaDown = () =>
  guardianWorld({ [OZ]: healthyGuardians[OZ], [KODA]: 503 });

test("on mainnet, refuses a document whose new Guardian operator is down and warns about a listed one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wallet-config-validate-"));
  try {
    writeFileSync(
      path.join(root, "mainnet.json"),
      JSON.stringify(guardianDocument("mainnet")),
    );
    const added = await validateFile("mainnet.json", {
      root,
      smoke: true,
      fetchImpl: kodaDown(),
    });
    assert.deepEqual(added.errors, [KODA_DOWN]);
    assert.deepEqual(added.warnings, []);

    // The same document as the base branch's: every operator is already published.
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"],
    ]) {
      execFileSync("git", args, { cwd: root });
    }
    const listed = await validateFile("mainnet.json", {
      root,
      smoke: true,
      fetchImpl: kodaDown(),
      baseRef: "HEAD",
    });
    assert.deepEqual(listed.errors, []);
    assert.deepEqual(listed.warnings, [KODA_DOWN]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("on testnet, only warns when a new Guardian operator is down", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wallet-config-validate-"));
  try {
    writeFileSync(
      path.join(root, "testnet.json"),
      JSON.stringify(guardianDocument("testnet")),
    );
    const result = await validateFile("testnet.json", {
      root,
      smoke: true,
      fetchImpl: kodaDown(),
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.warnings, [KODA_DOWN]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const mainnet = JSON.parse(
  readFileSync(new URL("../mainnet.json", import.meta.url)),
);
// Exercise deposit defaults independently of the published pause switches.
const mainnetCopy = () => {
  const body = structuredClone(mainnet);
  for (const vault of body.earn.vaults) delete vault.depositsEnabled;
  return body;
};
const mainnetErrors = (body) =>
  parseBridgeConfigDetailed(body, "mainnet").errors;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const POSITIONS = "https://positions-mainnet.epochprotocol.xyz";
test("mainnet pauses every listed Earn vault without removing positions or withdrawal routes", () => {
  const config = parseBridgeConfig(mainnet, "mainnet");
  assert.equal(config.features.earn, true);
  assert.deepEqual(config.earn.vaults.map(({ id, depositsEnabled }) => ({ id, depositsEnabled })), [
    { id: "aave-v3-base-usdc", depositsEnabled: false },
    { id: "aave-v3-ethereum-usdc", depositsEnabled: false },
  ]);
  assert.equal(config["bridge-providers"].epoch.positionsUrl, POSITIONS);
  assert.equal(config["bridge-providers"].epoch.allocatorUrl, "https://mainnet-api.epochprotocol.xyz");
  for (const chain of ["ethereum", "base", "arbitrum"])
    assert.equal(config.supportedEvmChains[chain].bridges.epoch.withdrawalEnabled, true);
});
/** The mainnet document with one vault changed by `change`. */
const withVault = (change) => {
  const body = mainnetCopy();
  change(body.earn.vaults[0]);
  return body;
};
const hasError = (body, fragment) =>
  mainnetErrors(body).some((error) => error.includes(fragment));

test("reads the Earn vaults in document order with deposits on by default", () => {
  const config = parseBridgeConfig(mainnetCopy(), "mainnet");
  assert.deepEqual(
    config.earn.vaults.map((vault) => vault.id),
    ["aave-v3-base-usdc", "aave-v3-ethereum-usdc"],
  );
  assert.deepEqual(config.earn.vaults[0], {
    id: "aave-v3-base-usdc",
    marketUid: `AAVE_V3:8453:${BASE_USDC}`,
    name: "Aave V3 USDC",
    protocol: "1delta",
    depositsEnabled: true,
    logo: "icons/aave.svg",
  });
  assert.deepEqual(
    parseBridgeConfig(copy(), "testnet").earn.vaults.map(
      (vault) => vault.marketUid,
    ),
    [`DUMMY_LENDING:11155111:${source.supportedEvmChains.sepolia.bridges.epoch.tokens.USDC.contractAddress.toLowerCase()}`],
  );
});

test("reads a vault's optional about, risk and depositsEnabled as written", () => {
  const body = withVault((vault) => {
    vault.about = "a".repeat(200);
    vault.risk = "medium";
    vault.depositsEnabled = false;
  });
  const [vault] = parseBridgeConfig(body, "mainnet").earn.vaults;
  assert.equal(vault.about, "a".repeat(200));
  assert.equal(vault.risk, "medium");
  assert.equal(vault.depositsEnabled, false);
});

test("Earn on needs a non-empty vault list", () => {
  const missing = mainnetCopy();
  delete missing.earn;
  assert.ok(hasError(missing, "earn.vaults is required while features.earn is on"));
  const empty = mainnetCopy();
  empty.earn.vaults = [];
  assert.ok(hasError(empty, "earn.vaults must name at least one vault"));
  const noList = mainnetCopy();
  noList.earn = {};
  assert.ok(hasError(noList, "earn.vaults must be an array"));
  const notObject = mainnetCopy();
  notObject.earn = [];
  assert.ok(hasError(notObject, "earn must be an object"));
});

test("Earn off refuses an Earn section, and needs none", () => {
  for (const earn of [false, undefined]) {
    const stale = mainnetCopy();
    if (earn === undefined) delete stale.features.earn;
    else stale.features.earn = earn;
    assert.ok(hasError(stale, "earn must be omitted while features.earn is off"));
    const empty = mainnetCopy();
    empty.features.earn = earn;
    empty.earn.vaults = [];
    assert.ok(hasError(empty, "earn must be omitted while features.earn is off"));
    delete stale.earn;
    assert.deepEqual(mainnetErrors(stale), []);
  }
});

test("refuses a vault id that is not a lower-case slug, and a repeated id", () => {
  for (const id of ["Aave", "1aave", "-aave", "aave_v3", "", 7, undefined])
    assert.ok(
      hasError(withVault((vault) => { vault.id = id; }), "earn.vaults[0].id"),
      JSON.stringify(id),
    );
  assert.deepEqual(
    mainnetErrors(withVault((vault) => { vault.id = "a"; })),
    [],
  );
  const repeated = mainnetCopy();
  repeated.earn.vaults[1].id = repeated.earn.vaults[0].id;
  assert.ok(hasError(repeated, "earn.vaults names id aave-v3-base-usdc twice"));
});

test("refuses a market uid that is not LENDER_KEY:chainId:underlying", () => {
  for (const marketUid of [
    `aave_v3:42161:${ARBITRUM_USDC}`,
    `AAVE-V3:42161:${ARBITRUM_USDC}`,
    `:42161:${ARBITRUM_USDC}`,
    `AAVE_V3:0:${ARBITRUM_USDC}`,
    `AAVE_V3:042161:${ARBITRUM_USDC}`,
    `AAVE_V3:-1:${ARBITRUM_USDC}`,
    "AAVE_V3:42161:0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "AAVE_V3:42161:0xaf88",
    `AAVE_V3:${ARBITRUM_USDC}`,
    `AAVE_V3:42161:${ARBITRUM_USDC}:extra`,
    42161,
    undefined,
  ])
    assert.ok(
      hasError(
        withVault((vault) => { vault.marketUid = marketUid; }),
        "earn.vaults[0].marketUid must be LENDER_KEY:chainId:underlying",
      ),
      JSON.stringify(marketUid),
    );
});

test("refuses a market on a chain without an Epoch route", () => {
  // Arc is listed, but only with a USDCx route.
  assert.ok(
    hasError(
      withVault((vault) => {
        vault.marketUid = "AAVE_V3:5042:0x3600000000000000000000000000000000000000";
      }),
      "names chain 5042, which has no Epoch route",
    ),
  );
  // Optimism is not listed at all.
  assert.ok(
    hasError(
      withVault((vault) => {
        vault.marketUid = `AAVE_V3:10:${ARBITRUM_USDC}`;
      }),
      "names chain 10, which has no Epoch route",
    ),
  );
  const unrouted = mainnetCopy();
  delete unrouted.supportedEvmChains.base.bridges.epoch;
  assert.ok(hasError(unrouted, "names chain 8453, which has no Epoch route"));
});

test("refuses a market that lends anything but the chain's Epoch USDC", () => {
  assert.ok(
    hasError(
      withVault((vault) => {
        vault.marketUid = `AAVE_V3:42161:${BASE_USDC}`;
      }),
      `lends ${BASE_USDC}, not the Epoch USDC of chain 42161`,
    ),
  );
  const moved = mainnetCopy();
  moved.supportedEvmChains.ethereum.bridges.epoch.tokens.USDC.contractAddress =
    "0xdAC17F958D2ee523a2206206994597C13D831ec7";
  assert.ok(hasError(moved, "not the Epoch USDC of chain 1"));
});

test("refuses a market listed twice", () => {
  const repeated = mainnetCopy();
  repeated.earn.vaults[1].marketUid = repeated.earn.vaults[0].marketUid;
  assert.ok(
    hasError(repeated, `earn.vaults names market AAVE_V3:8453:${BASE_USDC} twice`),
  );
});

test("refuses a vault name that is empty, longer than 64 characters or not a string", () => {
  assert.deepEqual(
    mainnetErrors(withVault((vault) => { vault.name = "n".repeat(64); })),
    [],
  );
  for (const name of ["", "n".repeat(65), { en: "Aave" }, 7, undefined])
    assert.ok(
      hasError(withVault((vault) => { vault.name = name; }), "earn.vaults[0].name"),
      JSON.stringify(name),
    );
});

test("refuses a protocol Epoch does not hash", () => {
  for (const protocol of ["dummy-lending", "1delta"])
    assert.deepEqual(
      mainnetErrors(withVault((vault) => { vault.protocol = protocol; })),
      [],
    );
  for (const protocol of ["1Delta", "aave", "", 1, undefined])
    assert.ok(
      hasError(
        withVault((vault) => { vault.protocol = protocol; }),
        "earn.vaults[0].protocol must be one of 1delta, dummy-lending",
      ),
      JSON.stringify(protocol),
    );
});

test("refuses an about longer than 200 characters or not a string", () => {
  for (const about of ["a".repeat(201), 7, { en: "About" }])
    assert.ok(
      hasError(withVault((vault) => { vault.about = about; }), "earn.vaults[0].about"),
      JSON.stringify(about),
    );
});

test("refuses a risk outside low, medium and high", () => {
  for (const risk of ["low", "medium", "high"])
    assert.deepEqual(
      mainnetErrors(withVault((vault) => { vault.risk = risk; })),
      [],
    );
  for (const risk of ["Low", "none", "", 1])
    assert.ok(
      hasError(
        withVault((vault) => { vault.risk = risk; }),
        "earn.vaults[0].risk must be one of low, medium, high",
      ),
      JSON.stringify(risk),
    );
});

test("refuses a depositsEnabled that is not boolean", () => {
  for (const depositsEnabled of ["true", 1, null])
    assert.ok(
      hasError(
        withVault((vault) => { vault.depositsEnabled = depositsEnabled; }),
        "earn.vaults[0].depositsEnabled must be boolean",
      ),
      JSON.stringify(depositsEnabled),
    );
});

test("refuses a vault that is not an object", () => {
  const body = mainnetCopy();
  body.earn.vaults[0] = "aave-v3-base-usdc";
  assert.ok(hasError(body, "earn.vaults[0] must be an object"));
});

test("plans one catalogue check per lent token, and none while Earn is off", () => {
  const config = parseBridgeConfig(mainnetCopy(), "mainnet");
  const pools = plannedChecks(config).filter(
    (check) => check.kind === "earn-pools",
  );
  assert.deepEqual(
    pools.map(({ url, marketUids }) => ({ url, marketUids })),
    [
      [8453, BASE_USDC],
      [1, ETHEREUM_USDC],
    ].map(([chainId, underlying]) => ({
      url: `${POSITIONS}/pools?chainId=${chainId}&count=400&start=0&underlyings=${underlying}`,
      marketUids: [`AAVE_V3:${chainId}:${underlying}`],
    })),
  );
  const off = mainnetCopy();
  off.features.earn = false;
  delete off.earn;
  assert.equal(
    plannedChecks(parseBridgeConfig(off, "mainnet")).some(
      (check) => check.kind === "earn-pools",
    ),
    false,
  );
});

/** A catalogue that serves `served` for every request, or answers `status`. */
function catalogueWorld({ served = [], status = 200, body } = {}) {
  return async (url) => {
    const { pathname } = new URL(String(url));
    if (!pathname.endsWith("/pools")) throw new Error(`unexpected ${url}`);
    if (status !== 200) return new Response("missing", { status });
    return Response.json(
      body ?? {
        success: true,
        data: {
          start: 0,
          count: served.length,
          items: served.map((marketUid) => ({ marketUid })),
        },
      },
    );
  };
}
const poolsOnly = (config) => ({
  ...config,
  guardians: [],
  supportedEvmChains: {},
});
const allMainnetUids = mainnet.earn.vaults.map((vault) => vault.marketUid);

test("passes the catalogue check when Epoch serves every listed market, in any case", async () => {
  const config = poolsOnly(parseBridgeConfig(mainnetCopy(), "mainnet"));
  const results = (
    await smokeTest(
      config,
      catalogueWorld({
        served: [
          ...allMainnetUids.map((uid) => uid.toUpperCase()),
          "MORPHO_BLUE_00:8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        ],
      }),
    )
  ).filter((result) => result.label.startsWith("Earn markets"));
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.ok));
});

test("fails the catalogue check when Epoch does not serve a listed market", async () => {
  const config = poolsOnly(parseBridgeConfig(mainnetCopy(), "mainnet"));
  const missing = `AAVE_V3:8453:${BASE_USDC}`;
  const results = (
    await smokeTest(
      config,
      catalogueWorld({
        served: allMainnetUids.filter((uid) => uid !== missing),
      }),
    )
  ).filter((result) => result.label.startsWith("Earn markets"));
  const failed = results.filter((result) => !result.ok);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].advisory, false);
  assert.match(failed[0].detail, new RegExp(`does not serve ${missing}`));
});

test("fails the catalogue check on a server error or an answer without data.items", async () => {
  const config = poolsOnly(parseBridgeConfig(mainnetCopy(), "mainnet"));
  for (const world of [
    catalogueWorld({ status: 500 }),
    catalogueWorld({ body: { success: true, data: {} } }),
    catalogueWorld({ body: [] }),
  ]) {
    const results = (await smokeTest(config, world)).filter((result) =>
      result.label.startsWith("Earn markets"),
    );
    assert.ok(results.every((result) => !result.ok && !result.advisory));
  }
});

test("only warns when the catalogue host has no /pools route", async () => {
  const config = poolsOnly(parseBridgeConfig(copy(), "testnet"));
  const [result] = (
    await smokeTest(config, catalogueWorld({ status: 404 }))
  ).filter((entry) => entry.label.startsWith("Earn markets"));
  assert.equal(result.ok, false);
  assert.equal(result.advisory, true);
  assert.match(result.detail, /cannot be verified/);
});

test("--no-smoke makes no catalogue request", async () => {
  const result = await validateFile("mainnet.json", {
    smoke: false,
    fetchImpl: async () => {
      throw new Error("no request expected");
    },
  });
  assert.deepEqual(result.errors, []);
});

const PLAIN_SVG = '<svg viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>';
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
/** A repository root that holds `files` (path to contents) under a fresh temporary directory. */
function withRepo(files, run) {
  const root = mkdtempSync(path.join(tmpdir(), "config-logo-test-"));
  try {
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      writeFileSync(path.join(root, name), contents);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
/**
 * The errors of vault 0 in the mainnet document with its logo set to `logo`, read against `root`.
 * The other vaults' logos are not in `root`, so their errors are left out.
 */
const logoErrors = (logo, root) =>
  parseBridgeConfigDetailed(
    withVault((vault) => {
      vault.logo = logo;
    }),
    "mainnet",
    { root },
  ).errors.filter((error) => error.startsWith("earn.vaults[0]."));
const svgErrors = (text) => earnLogoErrors(Buffer.from(text), "icons/mark.svg");

test("reads the published vault logos, and several vaults share one file", () => {
  const vaults = parseBridgeConfig(mainnetCopy(), "mainnet").earn.vaults;
  assert.deepEqual(
    vaults.map((vault) => vault.logo),
    ["icons/aave.svg", "icons/aave.svg"],
  );
  for (const file of ["aave", "compound", "morpho"]) {
    const logo = `icons/${file}.svg`;
    assert.deepEqual(
      earnLogoErrors(readFileSync(new URL(`../${logo}`, import.meta.url)), logo),
      [],
      logo,
    );
  }
});

test("reads no logo from a vault that names none", () => {
  const body = mainnetCopy();
  delete body.earn.vaults[0].logo;
  const [vault] = parseBridgeConfig(body, "mainnet").earn.vaults;
  assert.equal("logo" in vault, false);
});

test("refuses a logo that is not a path icons/<name>.svg or icons/<name>.png", () => {
  withRepo({ "icons/aave.svg": PLAIN_SVG, "icons/sub/aave.svg": PLAIN_SVG }, (root) => {
    assert.deepEqual(logoErrors("icons/aave.svg", root), []);
    for (const logo of [
      "aave.svg",
      "/icons/aave.svg",
      "./icons/aave.svg",
      "icons/../icons/aave.svg",
      "icons/sub/aave.svg",
      "icons/Aave.svg",
      "icons/aave.SVG",
      "icons/aave.gif",
      "icons/aave.svg.png",
      "icons/a--b.svg",
      "icons/-aave.svg",
      "icons/aave_v3.svg",
      "icons/.svg",
      "https://example.com/icons/aave.svg",
      "",
      7,
      null,
    ])
      assert.ok(
        logoErrors(logo, root).some((error) =>
          error.startsWith("earn.vaults[0].logo must be a path icons/<name>.svg"),
        ),
        JSON.stringify(logo),
      );
  });
});

test("refuses a logo that names no file in the repository, a directory or a link", () => {
  withRepo({ "icons/aave.svg": PLAIN_SVG, "icons/dir.svg/x": "" }, (root) => {
    symlinkSync(path.join(root, "icons/aave.svg"), path.join(root, "icons/link.svg"));
    for (const logo of ["icons/missing.svg", "icons/dir.svg", "icons/link.svg"])
      assert.deepEqual(
        logoErrors(logo, root),
        [`earn.vaults[0].logo names ${logo}, which is not a file in the repository`],
        logo,
      );
  });
});

test("refuses a logo file larger than 64 KiB", () => {
  const padded = (size) => `${PLAIN_SVG}${" ".repeat(size - PLAIN_SVG.length)}`;
  withRepo(
    {
      "icons/cap.svg": padded(MAX_EARN_VAULT_LOGO_BYTES),
      "icons/over.svg": padded(MAX_EARN_VAULT_LOGO_BYTES + 1),
    },
    (root) => {
      assert.deepEqual(logoErrors("icons/cap.svg", root), []);
      assert.deepEqual(logoErrors("icons/over.svg", root), [
        `earn.vaults[0].logo names icons/over.svg, which is ${MAX_EARN_VAULT_LOGO_BYTES + 1} bytes, more than ${MAX_EARN_VAULT_LOGO_BYTES}`,
      ]);
    },
  );
  assert.ok(
    earnLogoErrors(Buffer.alloc(MAX_EARN_VAULT_LOGO_BYTES + 1), "icons/a.png").length > 0,
  );
});

test("refuses a PNG logo without the PNG signature", () => {
  withRepo(
    {
      "icons/good.png": PNG_BYTES,
      "icons/svg.png": PLAIN_SVG,
      "icons/short.png": PNG_BYTES.subarray(0, 7),
    },
    (root) => {
      assert.deepEqual(logoErrors("icons/good.png", root), []);
      for (const logo of ["icons/svg.png", "icons/short.png"])
        assert.deepEqual(
          logoErrors(logo, root),
          [`earn.vaults[0].logo names ${logo}, which does not start with the PNG signature`],
          logo,
        );
    },
  );
});

test("refuses an SVG logo that is not UTF-8 text starting with <svg", () => {
  assert.deepEqual(svgErrors(PLAIN_SVG), []);
  assert.deepEqual(svgErrors(`\n  ${PLAIN_SVG}`), []);
  assert.deepEqual(svgErrors(`<?xml version="1.0" encoding="UTF-8"?>\n${PLAIN_SVG}`), []);
  assert.deepEqual(earnLogoErrors(Buffer.from(`﻿${PLAIN_SVG}`), "icons/a.svg"), []);
  for (const text of [
    `<!-- a comment -->${PLAIN_SVG}`,
    `<!DOCTYPE svg>${PLAIN_SVG}`,
    `<svgx/>`,
    `<html>${PLAIN_SVG}</html>`,
    "",
  ])
    assert.ok(
      svgErrors(text).includes("does not start with <svg after an optional XML declaration"),
      JSON.stringify(text),
    );
  assert.deepEqual(earnLogoErrors(PNG_BYTES, "icons/a.svg"), ["is not UTF-8 text"]);
  withRepo({ "icons/png.svg": PNG_BYTES }, (root) =>
    assert.deepEqual(logoErrors("icons/png.svg", root), [
      "earn.vaults[0].logo names icons/png.svg, which is not UTF-8 text",
    ]),
  );
});

test("refuses an SVG logo that could run code or load a remote resource", () => {
  const inside = (markup) => PLAIN_SVG.replace("</svg>", `${markup}</svg>`);
  for (const [markup, reason] of [
    ["<script>alert(1)</script>", "contains a <script> element"],
    ["<SCRIPT/>", "contains a <script> element"],
    ["<foreignObject><div/></foreignObject>", "contains a <foreignObject> element"],
    ["<foreignobject/>", "contains a <foreignObject> element"],
    ['<rect onload="x()"/>', "contains an event handler attribute (on…)"],
    ['<rect\nonclick = "x()"/>', "contains an event handler attribute (on…)"],
    ['<rect ONMOUSEOVER="x()"/>', "contains an event handler attribute (on…)"],
    ['<a href="javascript:x()"/>', "contains a javascript: URL"],
    ['<image href="https://example.com/a.png"/>', "contains an href or xlink:href that does not start with #"],
    ['<image xlink:href="data:image/png;base64,AA"/>', "contains an href or xlink:href that does not start with #"],
    ["<use href='other.svg#a'/>", "contains an href or xlink:href that does not start with #"],
    ["<use href=a/>", "contains an href or xlink:href that does not start with #"],
    ['<use href = ""/>', "contains an href or xlink:href that does not start with #"],
  ])
    assert.ok(svgErrors(inside(markup)).includes(reason), markup);
  for (const markup of [
    '<use href="#a"/>',
    "<use xlink:href='#a'/>",
    '<use href = "#a"/>',
    '<path fill="url(#g)" d="M0 0"/>',
    '<rect fill-opacity="1"/>',
  ])
    assert.deepEqual(svgErrors(inside(markup)), [], markup);
  withRepo({ "icons/bad.svg": inside("<script/>") }, (root) =>
    assert.deepEqual(logoErrors("icons/bad.svg", root), [
      "earn.vaults[0].logo names icons/bad.svg, which contains a <script> element",
    ]),
  );
});

test("--no-smoke reads each logo from the document's repository", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "config-logo-test-"));
  try {
    writeFileSync(path.join(root, "mainnet.json"), JSON.stringify(mainnetCopy()));
    mkdirSync(path.join(root, "icons"));
    writeFileSync(path.join(root, "icons/compound.svg"), PLAIN_SVG);
    const result = await validateFile("mainnet.json", {
      root,
      smoke: false,
      fetchImpl: async () => {
        throw new Error("no request expected");
      },
    });
    assert.deepEqual(
      result.errors,
      [0, 1].map(
        (index) =>
          `earn.vaults[${index}].logo names icons/aave.svg, which is not a file in the repository`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Runs the command line over `files` in a fresh directory and returns its exit code and output. */
async function runMain(t, files, fetchImpl) {
  const root = mkdtempSync(path.join(tmpdir(), "wallet-config-main-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [name, body] of Object.entries(files))
    writeFileSync(path.join(root, name), JSON.stringify(body));
  const lines = [];
  const capture = (line) => lines.push(line);
  t.mock.method(console, "log", capture);
  t.mock.method(console, "error", capture);
  try {
    return { code: await main([], { root, baseRef: "", fetchImpl }), lines };
  } finally {
    t.mock.restoreAll();
  }
}

test("exits 0 and prints the warning and its annotation when a testnet live check fails", async (t) => {
  const { code, lines } = await runMain(
    t,
    { "testnet.json": guardianDocument("testnet") },
    kodaDown(),
  );
  assert.equal(code, 0, lines.join("\n"));
  assert.ok(lines.includes(`  ⚠ warning: ${KODA_DOWN}`), lines.join("\n"));
  assert.ok(lines.includes(`::warning file=testnet.json::${KODA_DOWN}`));
  assert.ok(!lines.some((line) => line.startsWith("  ✗")));
});

test("exits 1 when a mainnet live check fails", async (t) => {
  const { code, lines } = await runMain(
    t,
    {
      "mainnet.json": guardianDocument("mainnet"),
      "testnet.json": guardianDocument("testnet"),
    },
    kodaDown(),
  );
  assert.equal(code, 1, lines.join("\n"));
  const mainnet = lines.indexOf("\nmainnet.json");
  const testnet = lines.indexOf("\ntestnet.json");
  assert.ok(mainnet >= 0 && testnet > mainnet, lines.join("\n"));
  const mainnetLines = lines.slice(mainnet, testnet);
  const testnetLines = lines.slice(testnet);
  assert.ok(mainnetLines.includes(`  ✗ ${KODA_DOWN}`), lines.join("\n"));
  assert.ok(!mainnetLines.some((line) => line.startsWith("::warning")));
  assert.ok(testnetLines.includes(`  ⚠ warning: ${KODA_DOWN}`));
  assert.ok(!testnetLines.some((line) => line.startsWith("  ✗")));
});

test("exits 1 on a testnet schema error and makes no live check", async (t) => {
  const body = guardianDocument("testnet");
  body.guardians[0].endpoint = "http://guardian.example.com";
  const { code, lines } = await runMain(t, { "testnet.json": body }, () => {
    throw new Error("no live check may run");
  });
  assert.equal(code, 1);
  assert.ok(lines.some((line) => line.startsWith("  ✗ ")), lines.join("\n"));
  assert.ok(!lines.some((line) => line.startsWith("::warning")));
});

test("escapes an annotation so a message cannot end it early or start another", () => {
  assert.equal(
    warningAnnotation("a:b,c.json", "50% down\n::error::x"),
    "::warning file=a%3Ab%2Cc.json::50%25 down%0A::error::x",
  );
});

function serviceDocument() {
  const body = mainnetCopy();
  delete body.guardians;
  for (const vault of body.earn.vaults) delete vault.logo;
  for (const chain of Object.values(body.supportedEvmChains))
    for (const bridge of Object.values(chain.bridges)) {
      bridge.depositEnabled = false;
      bridge.withdrawalEnabled = false;
    }
  body.supportedEvmChains.ethereum.bridges.agglayer.depositEnabled = true;
  return body;
}

function serviceWorld(reply) {
  return async (url, init = {}) => {
    if (init.method !== "POST") return reply(String(url));
    const { method } = JSON.parse(init.body);
    return Response.json({
      result: method === "eth_chainId" ? "0x1"
        : method === "eth_call" ? `0x${"0".repeat(63)}6` : "0x1234",
    });
  };
}

test("only HTTP 502 service health and Earn pools responses are advisory", async (t) => {
  const config = parseBridgeConfig(serviceDocument(), "mainnet");
  const checks = plannedChecks(config).filter(
    (check) => check.kind === "http" || check.kind === "earn-pools",
  );
  assert.equal(checks.length, 5);
  assert.deepEqual(checks.filter((check) => check.kind === "http").map((check) => check.key).sort(),
    ["allocator", "indexer", "positions"]);
  for (const status of [502, 500, 503, 526]) {
    await t.test(`HTTP ${status}`, async () => {
      const results = await smokeTest(config, serviceWorld(
        () => new Response("upstream unavailable", { status }),
      ));
      for (const check of checks) {
        const result = results.find((entry) => entry.label === (check.label ?? check.key));
        assert.equal(result.ok, false);
        assert.equal(result.advisory, status === 502, check.url);
        assert.equal(result.detail, `${check.url} answered HTTP ${status}`);
      }
      assert.ok(results.filter((entry) => !checks.some(
        (check) => entry.label === (check.label ?? check.key),
      )).every((entry) => entry.ok));
    });
  }
});

test("transport and semantic errors cannot qualify by mentioning HTTP 502", async (t) => {
  const config = parseBridgeConfig(serviceDocument(), "mainnet");
  for (const [name, reply] of [
    ["DNS", () => { throw new Error("DNS failure: HTTP 502"); }],
    ["TLS", () => { throw new Error("TLS failure: HTTP 502"); }],
    ["invalid JSON", () => new Response("HTTP 502", { status: 200 })],
    ["unhealthy payload", () => Response.json({ status: "HTTP 502", ok: false })],
  ]) {
    await t.test(name, async () => {
      const results = await smokeTest(config, serviceWorld(reply));
      const failed = results.filter((entry) => !entry.ok);
      assert.equal(failed.length, 5);
      assert.ok(failed.every((entry) => entry.advisory === false));
    });
  }
});

test("HTTP 502 RPC and new Guardian failures remain blocking", async () => {
  const config = parseBridgeConfig(serviceDocument(), "mainnet");
  const results = await smokeTest(config,
    async () => new Response("upstream unavailable", { status: 502 }));
  const chain = results.find((entry) => entry.label === "chain:1");
  assert.equal(chain.ok, false);
  assert.equal(chain.advisory, false);
  assert.match(chain.detail, /no RPC for chain 1 answered/);
  const guardians = await smokeTest(guardianFixture(),
    guardianWorld({ [OZ]: 502, [KODA]: 502 }));
  assert.equal(guardians.length, 2);
  assert.ok(guardians.every((entry) => !entry.ok && !entry.advisory));
  assert.ok(guardians.every((entry) => entry.detail.endsWith("answered HTTP 502")));
});

test("HTTP 502 warnings preserve exact diagnostics and annotations without failing the CLI", async (t) => {
  const body = serviceDocument();
  const checks = plannedChecks(parseBridgeConfig(body, "mainnet")).filter(
    (check) => check.kind === "http" || check.kind === "earn-pools",
  );
  const { code, lines } = await runMain(t, { "mainnet.json": body },
    serviceWorld(() => new Response("upstream unavailable", { status: 502 })));
  assert.equal(code, 0, lines.join("\n"));
  assert.equal(checks.length, 5);
  for (const check of checks) {
    const detail = `${check.label ?? check.key}: ${check.url} answered HTTP 502`;
    assert.ok(lines.includes(`  ⚠ warning: ${detail}`), detail);
    assert.ok(lines.includes(warningAnnotation("mainnet.json", detail)), detail);
  }
  assert.ok(!lines.some((line) => line.startsWith("  ✗")), lines.join("\n"));
});

test("HTTP 502 warnings cannot hide missing Earn markets in a successful response", async (t) => {
  const { code, lines } = await runMain(t, { "mainnet.json": serviceDocument() },
    serviceWorld((url) => url.includes("/pools?")
      ? Response.json({ success: true, data: { items: [] } })
      : new Response("upstream unavailable", { status: 502 })));
  assert.equal(code, 1, lines.join("\n"));
  assert.equal(lines.filter((line) => line.startsWith("  ✗ Earn markets")).length, 2);
  assert.equal(lines.filter((line) => line.startsWith("  ⚠ warning:")).length, 3);
  assert.ok(lines.some((line) => line.includes("does not serve AAVE_V3:")));
});

test("success-shaped HTTP 502 is not an RPC answer", async (t) => {
  await t.test("chain, code, and uint stay failed", async () => {
    const config = parseBridgeConfig(serviceDocument(), "mainnet");
    const checks = plannedChecks(config).filter((check) => check.kind.startsWith("evm-"));
    assert.deepEqual([...new Set(checks.map((check) => check.kind))].sort(),
      ["evm-chain", "evm-code", "evm-uint"]);
    const results = await smokeTest(config, async (url, init = {}) => {
      if (init.method === "POST") {
        const { method } = JSON.parse(init.body);
        const result = method === "eth_chainId" ? "0x1"
          : method === "eth_call" ? `0x${"0".repeat(63)}6` : "0x1234";
        return Response.json({ jsonrpc: "2.0", id: 1, result }, { status: 502 });
      }
      return Response.json({
        status: String(url).endsWith("/healthz") ? "SERVING" : "healthy",
        ok: true,
        data: { items: allMainnetUids.map((marketUid) => ({ marketUid })) },
      });
    });
    for (const check of checks) {
      const entry = results.find((result) => result.label === (check.label ?? check.key));
      assert.equal(entry.ok, false, check.key);
      assert.equal(entry.advisory, false, check.key);
      for (const url of EVM_RPCS[check.chainId])
        assert.ok(entry.detail.includes(`${url}: HTTP 502`), entry.detail);
    }
  });
  await t.test("a later HTTP 200 answer is used", async () => {
    const urls = [];
    const answered = await evmRpc(5042, "eth_chainId", [], async (url) => {
      urls.push(url);
      return Response.json({ jsonrpc: "2.0", id: 1, result: urls.length === 1 ? "0x11" : "0x22" },
        { status: urls.length === 1 ? 502 : 200 });
    });
    assert.equal(answered, "0x22");
    assert.deepEqual(urls, EVM_RPCS[5042]);
  });
});
