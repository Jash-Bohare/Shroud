import pino from "pino";

export const REDACTED_PATHS = [
  "*.apiKey",
  "*.api_key",
  "*.token",
  "*.secret",
  "*.code",
  "*.redemption*",
  "*.mnemonic",
  "*.identity*",
  "*.seed",
  "*.password",
  "*.authorization",
  "apiKey",
  "api_key",
  "token",
  "secret",
  "code",
  "mnemonic",
  "authorization",
  "headers.authorization",
  "headers.Authorization"
];

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  redact: {
    paths: REDACTED_PATHS,
    censor: "[REDACTED]"
  },
  timestamp: pino.stdTimeFunctions.isoTime
});

