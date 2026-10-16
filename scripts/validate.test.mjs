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
const copy = () => {
  const body = structuredClone(source);
  delete body.chains;
  return body;
};
// The route and service checks alone: the Guardian checks have their own tests below.
const withoutGuardians = () => {
  const body = copy();
  delete body.guardians;
  return body;
};
const errors = (body) => parseBridgeConfigDetailed(body, "testnet").errors;
test("published documents use the new schema", async () => {
  for (const file of ["testnet.json", "devnet.json"])
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
  ];
  for (const [index, change] of cases.entries())
    await t.test(`rejects route mutation ${index + 1}`, () => {
      const body = copy();
      change(body);
      assert.ok(errors(body).length > 0);
    });
});
test("mainnet Epoch does not need a testnet faucet or market", () => {
  const body = copy();
  delete body["bridge-providers"].epoch.outputs;
  delete body.supportedEvmChains.sepolia.bridges.epoch.tokens.USDC.outputs;
  assert.deepEqual(errors(body), []);
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
  assert.deepEqual(source.features, {
    earn: true,
    fastBridge: true,
    bridgeIn: true,
    bridgeOut: true,
  });
  for (const name of Object.keys(source.features)) {
    const body = copy();
    body.features[name] = false;
    const result = parseBridgeConfigDetailed(body, "testnet");
    assert.deepEqual(result.errors, []);
    assert.equal(result.config.features[name], false);
    body.features[name] = "true";
    assert.ok(errors(body).some((error) => error.includes(`features.${name}`)));
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
  assert.notEqual(
    parse({ about: "a".repeat(160), kind: "k".repeat(64) }),
    null,
  );
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
    const fetchImpl = guardianWorld({
      [OZ]: healthyGuardians[OZ],
      [KODA]: 503,
    });
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

test("chains stages 10 destinations and preserves the four published routes", () => {
  const body = structuredClone(source);
  const result = parseBridgeConfigDetailed(body, "testnet");
  assert.deepEqual(result.errors, []);
  assert.equal(Object.keys(result.config.chains).length, 10);
  assert.equal(Object.keys(result.config.supportedEvmChains).length, 9);
  const domains = Object.values(body.chains).map(
    (chain) => chain.bridges.usdcx.domain,
  );
  assert.deepEqual(
    domains.sort((a, b) => a - b),
    [0, 1, 2, 3, 5, 6, 7, 15, 19, 26],
  );
  for (const [slug, chain] of Object.entries(body.chains)) {
    if (body.supportedEvmChains[slug]) {
      const { family, ...legacy } = chain;
      assert.equal(family, "evm");
      assert.deepEqual(legacy, body.supportedEvmChains[slug]);
      continue;
    }
    assert.equal(chain.bridges.usdcx.depositEnabled, false);
    assert.equal(chain.bridges.usdcx.withdrawalEnabled, false);
    assert.equal(chain.bridges.usdcx.deposit, undefined);
  }
  const descriptions = (config) =>
    plannedChecks(config).map(({ healthy, ...check }) => check);
  assert.deepEqual(
    descriptions(result.config),
    descriptions(parseBridgeConfig(copy(), "testnet")),
  );
});

test("chains rejects invalid families, identities, domains, and legacy drift", async (t) => {
  const mutations = [
    (b) => {
      b.chains = null;
    },
    (b) => {
      b.chains["avalanche-fuji"].family = "other";
    },
    (b) => {
      delete b.chains["avalanche-fuji"].family;
    },
    (b) => {
      b.chains["avalanche-fuji"].chainId = 43114;
    },
    (b) => {
      b.chains["avalanche-fuji"].bridges.usdcx.domain = 0;
    },
    (b) => {
      b.chains["avalanche-fuji"].bridges.usdcx.tokens.USDC.contractAddress =
        "invalid";
    },
    (b) => {
      b.chains["solana-devnet"].chainId = 5;
    },
    (b) => {
      b.chains["solana-devnet"].cluster = "mainnet-beta";
    },
    (b) => {
      b.chains["solana-devnet"].bridges.usdcx.domain = 6;
    },
    (b) => {
      b.chains["solana-devnet"].bridges.usdcx.withdrawalEnabled = "true";
    },
    (b) => {
      b.chains["solana-devnet"].bridges.usdcx.depositEnabled = true;
    },
    (b) => {
      b.chains["solana-devnet"].bridges.usdcx.tokens.USDC.mintAddress =
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    },
    (b) => {
      b.chains.sepolia.bridges.usdcx.withdrawalEnabled = false;
    },
    (b) => {
      delete b.chains.sepolia;
    },
    (b) => {
      b.supportedEvmChains.sepolia.chainId = 1;
    },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`rejects chains mutation ${index + 1}`, () => {
      const body = structuredClone(source);
      mutate(body);
      assert.equal(parseBridgeConfigDetailed(body, "testnet").config, null);
    });
  }
});

test("chains works without the legacy field and detects duplicate keys", () => {
  const body = structuredClone(source);
  delete body.supportedEvmChains;
  assert.deepEqual(errors(body), []);
  assert.deepEqual(
    duplicateKeys('{"chains":{"solana-devnet":{},"solana-devnet":{}}}', [
      "chains",
    ]),
    ["solana-devnet"],
  );
});

test("Solana withdrawal checks the token mint through Solana RPC", async () => {
  const body = structuredClone(source);
  delete body.guardians;
  delete body.supportedEvmChains;
  body.chains = { "solana-devnet": body.chains["solana-devnet"] };
  body.chains["solana-devnet"].bridges.usdcx.withdrawalEnabled = true;
  body.features.earn = false;
  const config = parseBridgeConfig(body, "testnet");
  assert.equal(plannedChecks(config).length, 1);
  const account = {
    owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    data: {
      parsed: { type: "mint", info: { decimals: 6, isInitialized: true } },
    },
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, "https://api.devnet.solana.com");
    const request = JSON.parse(options.body);
    assert.equal(request.method, "getAccountInfo");
    assert.equal(
      request.params[0],
      "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
    );
    return { status: 200, json: async () => ({ result: { value: account } }) };
  };
  assert.equal((await smokeTest(config, fetchImpl))[0].ok, true);
  account.data.parsed.info.decimals = 9;
  assert.equal((await smokeTest(config, fetchImpl))[0].ok, false);
  assert.equal(
    (
      await smokeTest(config, async () => {
        throw new Error("RPC unavailable");
      })
    )[0].ok,
    false,
  );
});
