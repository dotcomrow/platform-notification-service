import { Kafka, logLevel, Producer } from "kafkajs";
import { config } from "../config.js";
import { JsonRecord, truncate } from "./json.js";
import { optionalVaultValue } from "./vault.js";

let producerPromise: Promise<Producer> | null = null;

async function kafkaCredentials(): Promise<{ username: string; password: string } | null> {
  const username = config.kafkaUsername || await optionalVaultValue(config.kafkaUsernameVaultPath, config.kafkaUsernameVaultKey);
  const password = config.kafkaPassword || await optionalVaultValue(config.kafkaPasswordVaultPath, config.kafkaPasswordVaultKey);
  if (!username && !password) {
    return null;
  }
  if (!username || !password) {
    throw new Error("Kafka SASL credentials are partially configured.");
  }
  return { username, password };
}

async function createProducer(): Promise<Producer> {
  if (!config.kafkaEnabled) {
    throw Object.assign(new Error("Kafka publishing is disabled."), { status: 503 });
  }
  const credentials = await kafkaCredentials();
  const sasl = credentials
    ? config.kafkaSaslMechanism === "plain"
      ? { mechanism: "plain" as const, username: credentials.username, password: credentials.password }
      : config.kafkaSaslMechanism === "scram-sha-512"
        ? { mechanism: "scram-sha-512" as const, username: credentials.username, password: credentials.password }
        : { mechanism: "scram-sha-256" as const, username: credentials.username, password: credentials.password }
    : undefined;
  const kafka = new Kafka({
    clientId: config.kafkaClientId,
    brokers: config.kafkaBrokers,
    ssl: config.kafkaSsl,
    logLevel: logLevel.WARN,
    ...(sasl ? { sasl } : {})
  });
  const producer = kafka.producer();
  await producer.connect();
  return producer;
}

async function producer(): Promise<Producer> {
  producerPromise ??= createProducer();
  return producerPromise;
}

export async function publishJson(topic: string, key: string, payload: JsonRecord): Promise<void> {
  const activeProducer = await producer();
  await activeProducer.send({
    topic,
    messages: [
      {
        key,
        value: JSON.stringify(payload),
        headers: {
          "content-type": "application/json",
          "schema-version": "1"
        }
      }
    ]
  });
}

export async function kafkaReady(): Promise<{ ok: boolean; enabled: boolean; error?: string }> {
  if (!config.kafkaEnabled) {
    return { ok: true, enabled: false };
  }
  try {
    await producer();
    return { ok: true, enabled: true };
  } catch (error) {
    producerPromise = null;
    return {
      ok: false,
      enabled: true,
      error: error instanceof Error ? truncate(error.message, 500) : "Unknown Kafka readiness error"
    };
  }
}

process.on("beforeExit", async () => {
  if (!producerPromise) {
    return;
  }
  try {
    const activeProducer = await producerPromise;
    await activeProducer.disconnect();
  } catch {
    // Process shutdown should not be blocked by producer cleanup.
  }
});
