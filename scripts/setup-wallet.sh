#!/usr/bin/env bash
set -euo pipefail
: "${ZDT_BIN:?}"; : "${ZDT_WALLET_DIR:?}"; : "${ZDT_IDENTITY_FILE:?}"
NET="${ZCASH_NETWORK:-test}"
mkdir -p "$(dirname "$ZDT_IDENTITY_FILE")"
mkdir -p "$ZDT_WALLET_DIR"
"$ZDT_BIN" wallet -w "$ZDT_WALLET_DIR" init --name vault -i "$ZDT_IDENTITY_FILE" -n "$NET"
"$ZDT_BIN" wallet -w "$ZDT_WALLET_DIR" sync
"$ZDT_BIN" wallet -w "$ZDT_WALLET_DIR" generate-account -i "$ZDT_IDENTITY_FILE" --name receipts
"$ZDT_BIN" wallet -w "$ZDT_WALLET_DIR" generate-account -i "$ZDT_IDENTITY_FILE" --name desk
"$ZDT_BIN" wallet -w "$ZDT_WALLET_DIR" list-accounts
chmod 600 "$ZDT_IDENTITY_FILE"
echo "Copy the three account UUIDs into .env: VAULT_ACCOUNT_UUID, RECEIPTS_ACCOUNT_UUID, DESK_ACCOUNT_UUID"

