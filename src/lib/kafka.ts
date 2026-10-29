import { Consumer, Kafka, logLevel, Producer } from "kafkajs";
import { config } from "../config.js";
import { JsonRecord, truncate } from "./json.js";
import { optionalVaultValue } from "./vault.js";

let producerPromise: Promise<Producer> | null = null;
let consumerPromise: Promise<Consumer> | null = null;
let consumerState: { ready: boolean; topic?: string; groupId?: string; error?: string } = { ready: false };

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

async function createKafka(): Promise<Kafka> {
  const credentials = await kafkaCredentials();
  const sasl = credentials
    ? config.kafkaSaslMechanism === "plain"
      ? { mechanism: "plain" as const, username: credentials.username, password: credentials.password }
      : config.kafkaSaslMechanism === "scram-sha-512"
        ? { mechanism: "scram-sha-512" as const, username: credentials.username, password: credentials.password }
        : { mechanism: "scram-sha-256" as const, username: credentials.username, password: credentials.password }
    : undefined;
  return new Kafka({
    clientId: config.kafkaClientId,
    brokers: config.kafkaBrokers,
    ssl: config.kafkaSsl,
    logLevel: logLevel.WARN,
    ...(sasl ? { sasl } : {})
  });
}

export async function runJsonConsumer(
  topic: string,
  groupId: string,
  handler: (payload: JsonRecord) => Promise<void>
): Promise<void> {
  if (!config.kafkaEnabled) {
    return;
  }
  const kafka = await createKafka();
  const consumer = kafka.consumer({ groupId });
  consumerPromise = Promise.resolve(consumer);
  consumerState = { ready: false, topic, groupId };
  consumer.on(consumer.events.GROUP_JOIN, () => {
    consumerState = { ready: true, topic, groupId };
  });
  let finishConsumer: (() => void) | null = null;
  let failConsumer: ((error: Error) => void) | null = null;
  const lifecycle = new Promise<void>((resolve, reject) => {
    finishConsumer = resolve;
    failConsumer = reject;
  });
  consumer.on(consumer.events.CRASH, ({ payload }) => {
    consumerState = { ready: false, topic, groupId, error: truncate(payload.error.message, 500) };
    if (!payload.restart) {
      failConsumer?.(payload.error);
    }
  });
  consumer.on(consumer.events.DISCONNECT, () => {
    consumerState = { ...consumerState, ready: false };
  });
  consumer.on(consumer.events.STOP, () => {
    finishConsumer?.();
  });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const text = message.value?.toString("utf8") || "";
      const parsed = JSON.parse(text) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Kafka event payload must be a JSON object.");
      }
      await handler(parsed as JsonRecord);
    }
  });
  await lifecycle;
}

export function kafkaConsumerReady(): { ok: boolean; enabled: boolean; topic?: string; group_id?: string; error?: string } {
  if (!config.kafkaEnabled) {
    return { ok: true, enabled: false };
  }
  return {
    ok: consumerState.ready,
    enabled: true,
    topic: consumerState.topic,
    group_id: consumerState.groupId,
    ...(consumerState.error ? { error: consumerState.error } : {})
  };
}

async function producer(): Promise<Producer> {
  producerPromise ??= createProducer();
  return producerPromise;
}

export async function publishJson(topic: string, key: string, payload: JsonRecord): Promise<void> {
  await publishJsonBatch(topic, [{ key, payload }]);
}

export async function publishJsonBatch(
  topic: string,
  entries: Array<{ key: string; payload: JsonRecord }>
): Promise<void> {
  const activeProducer = await producer();
  await activeProducer.send({
    topic,
    messages: entries.map(({ key, payload }) => ({
      key,
      value: JSON.stringify(payload),
      headers: {
        "content-type": "application/json",
        "schema-version": "1"
      }
    }))
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
  if (producerPromise) {
    try {
      const activeProducer = await producerPromise;
      await activeProducer.disconnect();
    } catch {
      // Process shutdown should not be blocked by producer cleanup.
    }
  }
  if (consumerPromise) {
    try {
      const activeConsumer = await consumerPromise;
      await activeConsumer.disconnect();
    } catch {
      // Process shutdown should not be blocked by consumer cleanup.
    }
  }
});
