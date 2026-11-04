import { execFile } from "node:child_process";
import { getEnv } from "../config/env.js";
import { ShroudError } from "../shared/errors.js";
import { logger } from "../shared/logger.js";
import { zcashMutex } from "../shared/mutex.js";

export interface DevtoolResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

export interface RunOpts {
  timeoutMs?: number;
  stdin?: string;
}

export interface ParsedBalance {
  totalZats: bigint;
  spendableZats: bigint;
  pendingZats: bigint;
  transparentZats: bigint;
  ironwoodSpendable: bigint;
  orchardSpendable: bigint;
  saplingSpendable: bigint;
  chainTipHeight: number;
}

export interface ParsedAccount {
  uuid: string;
  name: string;
  birthdayHeight: number;
  ufvk: string;
}

export interface ParsedTx {
  txid: string;
  minedHeight: number | null;
}

/**
 * Sanitizes command-line arguments for safe logging (hides memos and identity paths).
 */
export function redactCliArgs(args: string[]): string[] {
  return args.map((arg, idx) => {
    if (idx > 0 && (args[idx - 1] === "-i" || args[idx - 1] === "--identity")) {
      return "[REDACTED_IDENTITY_FILE]";
    }
    if (arg.includes("zcash:?") || arg.includes("memo=")) {
      return "[REDACTED_PAYMENT_URI]";
    }
    return arg;
  });
}

/**
 * Executes a zcash-devtool wallet command inside the global mutex queue using execFile.
 */
export async function runDevtool(args: string[], opts?: RunOpts): Promise<DevtoolResult> {
  const env = getEnv();
  const cmdArgs = ["wallet", "-w", env.ZDT_WALLET_DIR, ...args];

  // Determine default timeout based on command
  let defaultTimeout = 30_000;
  if (args.includes("sync")) {
    defaultTimeout = 600_000; // 10 min
  } else if (args.includes("pay") || args.includes("send")) {
    defaultTimeout = 180_000; // 3 min
  }
  const timeout = opts?.timeoutMs ?? defaultTimeout;

  return await zcashMutex.runExclusive(async () => {
    const startTime = Date.now();
    logger.debug({ cmd: env.ZDT_BIN, args: redactCliArgs(cmdArgs) }, "Executing zcash-devtool");

    try {
      const child = execFile(env.ZDT_BIN, cmdArgs, {
        timeout,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME
        }
      });

      if (opts?.stdin !== undefined) {
        child.stdin?.write(opts.stdin);
        child.stdin?.end();
      } else if (args.includes("init")) {
        child.stdin?.write("\n");
        child.stdin?.end();
      }

      const { stdout, stderr } = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let stdoutData = "";
        let stderrData = "";
        child.stdout?.on("data", (chunk) => {
          stdoutData += chunk;
        });
        child.stderr?.on("data", (chunk) => {
          stderrData += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve({ stdout: stdoutData, stderr: stderrData });
          } else {
            const err = new Error(`Command failed with exit code ${code}`);
            (err as any).code = code;
            (err as any).stdout = stdoutData;
            (err as any).stderr = stderrData;
            reject(err);
          }
        });
      });

      const durationMs = Date.now() - startTime;
      return {
        stdout,
        stderr,
        exitCode: 0,
        durationMs
      };
    } catch (err: any) {
      const durationMs = Date.now() - startTime;
      const stderr = err.stderr ? err.stderr.toString() : (err.message || "");
      const stdout = err.stdout ? err.stdout.toString() : "";

      // Filter out tracing logs (INFO, DEBUG, TRACE) from stderr to find actual error line
      const lines = stderr.split("\n").map((l: string) => l.trim()).filter(Boolean);
      const errorLines = lines.filter((l: string) =>
        !/^(?:\d{4}-\d{2}-\d{2}T|\d{2}:\d{2}:\d{2}|\[?\s*(?:INFO|DEBUG|TRACE)\s*\]?|INFO\s+|DEBUG\s+)/.test(l) &&
        !l.includes(" INFO ") &&
        !l.includes(" DEBUG ")
      );
      const realErrorSummary = errorLines.length > 0 ? errorLines[0] : (lines[lines.length - 1] || err.message);

      logger.warn(
        { err: realErrorSummary, durationMs, args: redactCliArgs(cmdArgs) },
        "zcash-devtool execution failed"
      );

      const errText = errorLines.join("\n");
      if (/Insufficient|InsufficientFunds/i.test(errText)) {
        throw new ShroudError("INSUFFICIENT_FUNDS", "Vault has insufficient spendable funds for this transaction");
      }
      if (/failed to connect|transport error|connection refused|deadline has elapsed|server unavailable|unreachable/i.test(errText)) {
        throw new ShroudError("LIGHTWALLETD_UNAVAILABLE", `Zcash lightwalletd server is unreachable: ${realErrorSummary}`);
      }

      throw new ShroudError("ZCASH_CLI_ERROR", `zcash-devtool error: ${realErrorSummary}`, {
        exitCode: err.code,
        stderr,
        stdout
      });
    }
  });
}

/**
 * Parses JSON output from `zcash-devtool wallet balance <uuid> --json`.
 */
export function parseBalanceJson(stdout: string): ParsedBalance {
  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new ShroudError("ZCASH_CLI_ERROR", `Could not parse balance JSON: ${stdout}`);
  }

  // Pre-parse using regex to capture large integer zat values directly as BigInt
  const raw = JSON.parse(jsonMatch[0]);

  const totalZats = BigInt(raw.total ?? 0);
  const ironwoodSpendable = BigInt(raw.ironwood_spendable ?? 0);
  const orchardSpendable = BigInt(raw.orchard_spendable ?? 0);
  const saplingSpendable = BigInt(raw.sapling_spendable ?? 0);
  const transparentZats = BigInt(raw.transparent_spendable ?? 0);
  const chainTipHeight = Number(raw.chain_tip_height ?? 0);

  const spendableZats = ironwoodSpendable + orchardSpendable + saplingSpendable;
  let pendingZats = totalZats - spendableZats - transparentZats;
  if (pendingZats < 0n) pendingZats = 0n;

  return {
    totalZats,
    spendableZats,
    pendingZats,
    transparentZats,
    ironwoodSpendable,
    orchardSpendable,
    saplingSpendable,
    chainTipHeight
  };
}

/**
 * Parses accounts from `zcash-devtool wallet list-accounts`.
 */
export function parseAccounts(stdout: string): ParsedAccount[] {
  const accounts: ParsedAccount[] = [];
  const lines = stdout.split("\n");

  let currentUuid = "";
  let currentBirthday = 0;
  let currentName = "";
  let currentUfvk = "";

  for (const line of lines) {
    const trimmed = line.trim();

    // Match "Account <uuid> (birthday height <height>)"
    const accountMatch = trimmed.match(/^Account\s+([0-9a-fA-F-]+)\s+\(birthday height\s+(\d+)\)/i);
    if (accountMatch) {
      if (currentUuid) {
        accounts.push({
          uuid: currentUuid,
          name: currentName,
          birthdayHeight: currentBirthday,
          ufvk: currentUfvk
        });
      }
      currentUuid = accountMatch[1];
      currentBirthday = Number(accountMatch[2]);
      currentName = "";
      currentUfvk = "";
      continue;
    }

    if (trimmed.startsWith("Name:")) {
      currentName = trimmed.replace("Name:", "").trim();
    } else if (trimmed.startsWith("UFVK:")) {
      currentUfvk = trimmed.replace("UFVK:", "").trim();
    }
  }

  if (currentUuid) {
    accounts.push({
      uuid: currentUuid,
      name: currentName,
      birthdayHeight: currentBirthday,
      ufvk: currentUfvk
    });
  }

  return accounts;
}

/**
 * Parses the first valid Unified Address (utest1... or u1...) from output.
 */
export function parseUnifiedAddress(stdout: string): string {
  const match = stdout.match(/(utest1|u1)[0-9a-z]{50,}/);
  if (!match) {
    throw new ShroudError("ZCASH_CLI_ERROR", "Failed to parse unified address from devtool output");
  }
  return match[0];
}

/**
 * Parses the 64-character hex transaction ID from the last non-empty line of send/pay output.
 */
export function parseTxid(stdout: string): string {
  const lines = stdout.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (/^[0-9a-fA-F]{64}$/.test(line)) {
      return line.toLowerCase();
    }
  }
  throw new ShroudError("ZCASH_CLI_ERROR", `No valid 64-hex txid found in pay output: "${stdout.slice(-200)}"`);
}

/**
 * Parses JSON output from `zcash-devtool wallet list-tx <uuid> --json`.
 */
export function parseListTxJson(stdout: string): ParsedTx[] {
  const jsonMatch = stdout.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const rawList = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(rawList)) return [];

    return rawList
      .filter((item) => item && typeof item.txid === "string")
      .map((item) => ({
        txid: item.txid.toLowerCase(),
        minedHeight: typeof item.mined_height === "number" ? item.mined_height : null
      }));
  } catch {
    return [];
  }
}

