import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseBridgeConfigDetailed,
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
  const body = copy();
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
      const results = await smokeTest(source, async (url, init) => {
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
