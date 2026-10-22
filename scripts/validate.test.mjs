import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseBridgeConfig,
  parseBridgeConfigDetailed,
  publishedGuardianEndpoints,
  validateFile,
  duplicateKeys,
  plannedChecks,
  smokeTest,
  versionError,
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
  assert.deepEqual(source.features, { earn: true, fastBridge: true, bridgeIn: true, bridgeOut: true });
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

test("refuses a document whose new Guardian operator is down and passes one whose listed operator is down", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wallet-config-validate-"));
  try {
    writeFileSync(
      path.join(root, "testnet.json"),
      JSON.stringify(readFixture("good", "testnet-guardians.json")),
    );
    const fetchImpl = guardianWorld({ [OZ]: healthyGuardians[OZ], [KODA]: 503 });
    const added = await validateFile("testnet.json", {
      root,
      smoke: true,
      fetchImpl,
    });
    assert.deepEqual(added.errors, [
      `Guardian kodax: ${KODA}/pubkey?scheme=ecdsa answered HTTP 503`,
    ]);

    // The same document as the base branch's: every operator is already published.
    for (const args of [
      ["init", "-q"],
      ["add", "."],
      ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base"],
    ]) {
      execFileSync("git", args, { cwd: root });
    }
    const listed = await validateFile("testnet.json", {
      root,
      smoke: true,
      fetchImpl,
      baseRef: "HEAD",
    });
    assert.deepEqual(listed.errors, []);
    assert.ok(
      listed.notes.includes(
        `warning: Guardian kodax: ${KODA}/pubkey?scheme=ecdsa answered HTTP 503`,
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const mainnet = JSON.parse(
  readFileSync(new URL("../mainnet.json", import.meta.url)),
);
const mainnetCopy = () => structuredClone(mainnet);
const mainnetErrors = (body) =>
  parseBridgeConfigDetailed(body, "mainnet").errors;
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const ETHEREUM_USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const POSITIONS = "https://miden-integration-example.epochprotocol.xyz/onedelta";
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
    [
      "aave-v3-arbitrum-usdc",
      "compound-v3-arbitrum-usdc",
      "aave-v3-base-usdc",
      "compound-v3-base-usdc",
      "aave-v3-ethereum-usdc",
      "compound-v3-ethereum-usdc",
    ],
  );
  assert.deepEqual(config.earn.vaults[0], {
    id: "aave-v3-arbitrum-usdc",
    marketUid: `AAVE_V3:42161:${ARBITRUM_USDC}`,
    name: "Aave V3 USDC",
    protocol: "1delta",
    depositsEnabled: true,
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
  assert.ok(hasError(repeated, "earn.vaults names id aave-v3-arbitrum-usdc twice"));
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
  delete unrouted.supportedEvmChains.arbitrum.bridges.epoch;
  assert.ok(hasError(unrouted, "names chain 42161, which has no Epoch route"));
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
    hasError(repeated, `earn.vaults names market AAVE_V3:42161:${ARBITRUM_USDC} twice`),
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
  body.earn.vaults[0] = "aave-v3-arbitrum-usdc";
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
      [42161, ARBITRUM_USDC],
      [8453, BASE_USDC],
      [1, ETHEREUM_USDC],
    ].map(([chainId, underlying]) => ({
      url: `${POSITIONS}/pools?chainId=${chainId}&count=400&start=0&underlyings=${underlying}`,
      marketUids: [
        `AAVE_V3:${chainId}:${underlying}`,
        `COMPOUND_V3_USDC:${chainId}:${underlying}`,
      ],
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
  assert.equal(results.length, 3);
  assert.ok(results.every((result) => result.ok));
});

test("fails the catalogue check when Epoch does not serve a listed market", async () => {
  const config = poolsOnly(parseBridgeConfig(mainnetCopy(), "mainnet"));
  const missing = `COMPOUND_V3_USDC:8453:${BASE_USDC}`;
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
