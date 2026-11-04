import { getEnv } from "../config/env.js";
import { ShroudError } from "../shared/errors.js";
import { ReceiptRecord } from "../shared/types.js";
import {
  runDevtool,
  parseBalanceJson,
  parseUnifiedAddress,
  parseTxid,
  parseListTxJson,
  ParsedBalance
} from "./devtool.js";
import { buildPaymentUri } from "./zip321.js";
import { encodeReceipt } from "./memo.js";
import { parseListTxCsv, parseListTxText, parseListTxOutputs, extractReceipts } from "./receipts.js";
import { z } from "zod";

const addressSchema = z.string().regex(/^(utest1|u1|ztestsapling1|zs1|tm|t1)[0-9a-z]+$/i, "Invalid Zcash address format");

export interface VaultConfig {
  network: "test" | "main";
  vaultUuid: string;
  receiptsUuid: string;
  deskUuid: string;
  receiptOutputZats: bigint;
  maxSinglePaymentZats: bigint;
  identityFile: string;
}

export interface PayInput {
  to: string;
  zats: bigint;
  toMemo?: string;
  receipt: {
    id: string;
    attemptId: string;
    mode: "demo" | "live";
    productId: string;
    productName: string;
    faceValue: string;
    faceCurrency: string;
    priceCents: number;
    zatsPaid: bigint | string;
    invoiceId?: string;
    orderId?: string;
    swapRef: string;
  };
  attemptId: string;
}

export type AccountName = "vault" | "receipts" | "desk";

export class VaultService {
  private cachedFundingAddress: string | null = null;
  private cachedReceiptsAddress: string | null = null;
  private cachedDeskAddress: string | null = null;

  constructor(
    private cfg: VaultConfig,
    private run: typeof runDevtool = runDevtool
  ) {}

  private getAccountUuid(account: AccountName): string {
    switch (account) {
      case "vault":
        return this.cfg.vaultUuid;
      case "receipts":
        return this.cfg.receiptsUuid;
      case "desk":
        return this.cfg.deskUuid;
    }
  }

  /**
   * Health check: verifies that zcash-devtool binary is available and reports version/network.
   */
  async health(): Promise<{ ok: boolean; network: "test" | "main"; message?: string }> {
    try {
      const res = await this.run(["--help"], { timeoutMs: 10_000 });
      return {
        ok: res.exitCode === 0,
        network: this.cfg.network
      };
    } catch (err: any) {
      return {
        ok: false,
        network: this.cfg.network,
        message: err.message
      };
    }
  }

  /**
   * Synchronizes the wallet with lightwalletd.
   */
  async sync(): Promise<void> {
    const env = getEnv();
    const args = ["sync"];
    if (env.ZDT_SERVER) {
      args.push("-s", env.ZDT_SERVER);
    }
    await this.run(args);
  }

  /**
   * Retrieves balance for an account (defaults to vault).
   */
  async getBalance(account: AccountName = "vault"): Promise<ParsedBalance> {
    const uuid = this.getAccountUuid(account);
    if (!uuid) {
      throw new ShroudError("ZCASH_CLI_ERROR", `Account UUID not configured for '${account}'`);
    }
    const res = await this.run(["balance", uuid, "--json"]);
    return parseBalanceJson(res.stdout);
  }

  /**
   * Returns the primary unified funding address for the vault.
   */
  async getFundingAddress(): Promise<string> {
    if (this.cachedFundingAddress) return this.cachedFundingAddress;
    const uuid = this.getAccountUuid("vault");
    const res = await this.run(["list-addresses", uuid]);
    this.cachedFundingAddress = parseUnifiedAddress(res.stdout);
    return this.cachedFundingAddress;
  }

  /**
   * Returns the shielded unified address for the receipts account.
   */
  async getReceiptsAddress(): Promise<string> {
    if (this.cachedReceiptsAddress) return this.cachedReceiptsAddress;
    const uuid = this.getAccountUuid("receipts");
    const res = await this.run(["list-addresses", uuid]);
    this.cachedReceiptsAddress = parseUnifiedAddress(res.stdout);
    return this.cachedReceiptsAddress;
  }

  /**
   * Returns the desk unified address (demo mode).
   */
  async getDeskAddress(): Promise<string> {
    if (this.cachedDeskAddress) return this.cachedDeskAddress;
    const uuid = this.getAccountUuid("desk");
    const res = await this.run(["list-addresses", uuid]);
    this.cachedDeskAddress = parseUnifiedAddress(res.stdout);
    return this.cachedDeskAddress;
  }

  /**
   * Generates a fresh diversified address for the vault (used as fresh refund address in live mode).
   */
  async newRefundAddress(): Promise<string> {
    const uuid = this.getAccountUuid("vault");
    const res = await this.run(["generate-address", uuid]);
    return parseUnifiedAddress(res.stdout);
  }

  /**
   * Executes a multi-output ZIP-321 payment:
   * Output 0: Merchant deposit or Demo desk address
   * Output 1: Receipts account with encrypted SHRD1 memo
   */
  async payWithReceipt(input: PayInput): Promise<{ txid: string }> {
    // 1. Validation
    const addrResult = addressSchema.safeParse(input.to);
    if (!addrResult.success) {
      throw new ShroudError("INVALID_ADDRESS", `Invalid recipient address: "${input.to}"`);
    }

    if (input.zats <= 0n) {
      throw new ShroudError("INVALID_SELECTION", "Payment amount must be greater than 0 zats");
    }

    if (input.zats > this.cfg.maxSinglePaymentZats) {
      throw new ShroudError(
        "PAYMENT_CAP_EXCEEDED",
        `Requested payment ${input.zats} zats exceeds safety cap of ${this.cfg.maxSinglePaymentZats} zats`
      );
    }

    // 2. Sync to get latest notes
    await this.sync();

    // 3. Balance verification
    const balance = await this.getBalance("vault");
    const feeBuffer = 50_000n; // Safety fee margin (0.0005 ZEC)
    const totalRequired = input.zats + this.cfg.receiptOutputZats + feeBuffer;

    if (balance.spendableZats < totalRequired) {
      throw new ShroudError(
        "INSUFFICIENT_FUNDS",
        `Insufficient spendable funds: vault has ${balance.spendableZats} zats spendable, but requires ${totalRequired} zats (including fees)`
      );
    }

    // 4. Construct ZIP-321 URI
    const receiptsAddress = await this.getReceiptsAddress();
    const memoText = encodeReceipt(input.receipt);

    const uri = buildPaymentUri([
      {
        address: input.to,
        zats: input.zats,
        memo: input.toMemo
      },
      {
        address: receiptsAddress,
        zats: this.cfg.receiptOutputZats,
        memo: memoText
      }
    ]);

    // 5. Execute pay command
    const res = await this.run([
      "pay",
      this.cfg.vaultUuid,
      "-i",
      this.cfg.identityFile,
      "--payment-uri",
      uri,
      "--disable-confirmation"
    ]);

    // 6. Parse and return transaction ID
    const txid = parseTxid(res.stdout);
    return { txid };
  }

  /**
   * Checks the confirmation count for a given transaction id.
   */
  async getTxConfirmations(txid: string, account: AccountName = "vault"): Promise<number | null> {
    const uuid = this.getAccountUuid(account);
    if (!uuid) return null;

    const res = await this.run(["list-tx", uuid, "--json"]);
    const list = parseListTxJson(res.stdout);
    const found = list.find((t) => t.txid.toLowerCase() === txid.toLowerCase());

    if (!found || found.minedHeight === null) {
      return null;
    }

    const bal = await this.getBalance(account);
    const confs = bal.chainTipHeight - found.minedHeight + 1;
    return confs >= 0 ? confs : 0;
  }

  /**
   * Finds the output paid to the desk account carrying `memo` (e.g. "SHROUD-DESK p_…"),
   * with its value and confirmations. This is how the desk matches payments to orders.
   */
  async findDeskPayment(
    memo: string
  ): Promise<{ txid: string; valueZats: bigint; confirmations: number } | null> {
    const deskUuid = this.cfg.deskUuid;
    if (!deskUuid) return null;
    const res = await this.run(["list-tx", deskUuid]);
    const out = parseListTxOutputs(res.stdout).find(
      (o) => o.memo === memo && o.receivedBy === deskUuid.toLowerCase()
    );
    if (!out) return null;
    if (out.minedHeight === null) return { txid: out.txid, valueZats: out.valueZats, confirmations: 0 };
    const tip = (await this.getBalance("desk")).chainTipHeight;
    return { txid: out.txid, valueZats: out.valueZats, confirmations: Math.max(0, tip - out.minedHeight + 1) };
  }

  /**
   * Lists all receipts found on-chain by trial-decrypting the receipts account memos.
   */
  async listReceipts(): Promise<ReceiptRecord[]> {
    const uuid = this.getAccountUuid("receipts");
    if (!uuid) return [];

    const res = await this.run(["list-tx", uuid]);
    const textRows = parseListTxText(res.stdout);
    const receipts = extractReceipts(textRows);

    if (receipts.length > 0) return receipts;

    const csvRes = await this.run(["list-tx", uuid, "--mode", "csv"]);
    const csvRows = parseListTxCsv(csvRes.stdout);
    return extractReceipts(csvRows);
  }

  /**
   * Idempotency helper: scans on-chain receipts for a matching attempt ID.
   */
  async findReceiptByAttempt(attemptId: string): Promise<ReceiptRecord | null> {
    const receipts = await this.listReceipts();
    return receipts.find((r) => r.receipt.a === attemptId) || null;
  }
}

