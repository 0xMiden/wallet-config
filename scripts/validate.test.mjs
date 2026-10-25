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
    const result = parseBridgeConfigDetailed(body, "testnet");
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.features[name], false);
    body.features[name] = "true";
    assert.ok(errors(body).some(error => error.includes(`features.${name}`)));
  }
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
