import { describe, it, expect, vi } from "vitest";
import { VaultService, VaultConfig } from "../../src/zcash/vault.js";
import { DevtoolResult } from "../../src/zcash/devtool.js";

describe("VaultService", () => {
  const dummyCfg: VaultConfig = {
    network: "test",
    vaultUuid: "00000000-0000-0000-0000-000000000001",
    receiptsUuid: "00000000-0000-0000-0000-000000000002",
    deskUuid: "00000000-0000-0000-0000-000000000003",
    receiptOutputZats: 0n,
    maxSinglePaymentZats: 50_000_000n, // 0.5 ZEC
    identityFile: "/dummy/identity.txt"
  };

  it("checks health successfully", async () => {
    const fakeRun = vi.fn().mockResolvedValue({
      stdout: "zcash-devtool 0.1.0\n",
      stderr: "",
      exitCode: 0,
      durationMs: 10
    } satisfies DevtoolResult);

    const vault = new VaultService(dummyCfg, fakeRun as any);
    const health = await vault.health();
    expect(health.ok).toBe(true);
    expect(health.network).toBe("test");
  });

  it("fetches and parses balance", async () => {
    const fakeRun = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        total: 100000000,
        sapling_spendable: 0,
        orchard_spendable: 0,
        ironwood_spendable: 100000000,
        transparent_spendable: 0,
        chain_tip_height: 3100500
      }),
      stderr: "",
      exitCode: 0,
      durationMs: 10
    } satisfies DevtoolResult);

    const vault = new VaultService(dummyCfg, fakeRun as any);
    const bal = await vault.getBalance("vault");
    expect(bal.spendableZats).toBe(100000000n);
    expect(bal.chainTipHeight).toBe(3100500);
  });

  it("rejects payments over MAX_SINGLE_PAYMENT_ZATS", async () => {
    const vault = new VaultService(dummyCfg, vi.fn() as any);
    await expect(
      vault.payWithReceipt({
        to: "utest1deskaccount000000000000000000000000000000000000000000000000",
        zats: 60_000_000n, // > 50M limit
        attemptId: "att_123",
        receipt: {
          id: "p_1",
          attemptId: "att_123",
          mode: "demo",
          productId: "test-card",
          productName: "Test Card",
          faceValue: "10",
          faceCurrency: "USD",
          priceCents: 1000,
          zatsPaid: 60000000n,
          swapRef: "desk"
        }
      })
    ).rejects.toThrow(/safety cap/i);
  });

  it("rejects payments when spendable funds are insufficient", async () => {
    const fakeRun = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "sync") return { stdout: "", stderr: "", exitCode: 0, durationMs: 5 };
      if (args[0] === "balance") {
        return {
          stdout: JSON.stringify({
            total: 20000,
            ironwood_spendable: 20000,
            chain_tip_height: 3100000
          }),
          stderr: "",
          exitCode: 0,
          durationMs: 5
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 5 };
    });

    const vault = new VaultService(dummyCfg, fakeRun as any);
    await expect(
      vault.payWithReceipt({
        to: "utest1deskaccount000000000000000000000000000000000000000000000000",
        zats: 100_000n, // requires 100k + 50k fee = 150k > 20k
        attemptId: "att_123",
        receipt: {
          id: "p_1",
          attemptId: "att_123",
          mode: "demo",
          productId: "test-card",
          productName: "Test Card",
          faceValue: "10",
          faceCurrency: "USD",
          priceCents: 1000,
          zatsPaid: 100000n,
          swapRef: "desk"
        }
      })
    ).rejects.toThrow(/insufficient spendable funds/i);
  });

  it("successfully builds URI and runs pay when funds are sufficient", async () => {
    let capturedPayArgs: string[] = [];

    const fakeRun = vi.fn().mockImplementation(async (args: string[]) => {
      if (args[0] === "sync") return { stdout: "", stderr: "", exitCode: 0, durationMs: 5 };
      if (args[0] === "balance") {
        return {
          stdout: JSON.stringify({
            total: 10000000,
            ironwood_spendable: 10000000,
            chain_tip_height: 3100000
          }),
          stderr: "",
          exitCode: 0,
          durationMs: 5
        };
      }
      if (args[0] === "list-addresses") {
        return {
          stdout: "Generated unified address: utest1receipts00000000000000000000000000000000000000000000000000",
          stderr: "",
          exitCode: 0,
          durationMs: 5
        };
      }
      if (args[0] === "pay") {
        capturedPayArgs = args;
        return {
          stdout: "Sending transaction...\n3f9a7b5c1d8e2f4a6b0c9e7d5a3f1b8c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f12\n",
          stderr: "",
          exitCode: 0,
          durationMs: 50
        };
      }
      return { stdout: "", stderr: "", exitCode: 0, durationMs: 5 };
    });

    const vault = new VaultService(dummyCfg, fakeRun as any);
    const result = await vault.payWithReceipt({
      to: "utest1desk00000000000000000000000000000000000000000000000000000000",
      zats: 10000n,
      attemptId: "att_01JTEST",
      receipt: {
        id: "p_01JTEST",
        attemptId: "att_01JTEST",
        mode: "demo",
        productId: "test-card",
        productName: "Test Card",
        faceValue: "500",
        faceCurrency: "INR",
        priceCents: 600,
        zatsPaid: 10000n,
        swapRef: "desk"
      }
    });

    expect(result.txid).toBe("3f9a7b5c1d8e2f4a6b0c9e7d5a3f1b8c2d4e6f8a0b2c4d6e8f0a2b4c6d8e0f12");
    expect(capturedPayArgs[0]).toBe("pay");
    expect(capturedPayArgs[1]).toBe(dummyCfg.vaultUuid);
    expect(capturedPayArgs[2]).toBe("-i");
    expect(capturedPayArgs[3]).toBe(dummyCfg.identityFile);
    expect(capturedPayArgs[4]).toBe("--payment-uri");
    expect(capturedPayArgs[5]).toContain("utest1desk");
    expect(capturedPayArgs[5]).toContain("memo.1=");
  });
});

