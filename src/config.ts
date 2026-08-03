import { z } from "zod";
import { asBoolean } from "./lib/json.js";

const envSchema = z.object({
  PORT: z.string().default("8080"),
  TRUST_PROXY_HOPS: z.string().default("1"),
  RATE_WINDOW_MS: z.string().default("60000"),
  RATE_MAX: z.string().default("120"),
  REQUEST_TIMEOUT_MS: z.string().default("10000"),
  AUTH_REQUIRED: z.string().default("true"),
  DIRECTUS_BASE_URL: z.string().default("http://directus-service.directus.svc.cluster.local:8055"),
  DIRECTUS_HEALTH_PATH: z.string().default("/server/health"),
  DIRECTUS_STATIC_TOKEN: z.string().default(""),
  DIRECTUS_TOKEN_VAULT_PATH: z.string().default("secret/data/directus/platform-notification-service"),
  DIRECTUS_TOKEN_VAULT_KEY: z.string().default("token"),
  BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_KEYS: z.string().default("cms-site-internal,cms-site-external,graphql-api"),
  BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_TOKEN_VAULT_PREFIX: z.string().default("secret/data/directus/gravitee/clients"),
  BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_TOKEN_VAULT_KEY: z.string().default("token"),
  INTERNAL_TOKEN: z.string().default(""),
  INTERNAL_TOKEN_VAULT_PATH: z.string().default("secret/data/platform-notification-service"),
  INTERNAL_TOKEN_VAULT_KEY: z.string().default("token"),
  BROWSER_PUSH_VAPID_PUBLIC_KEY: z.string().default(""),
  BROWSER_PUSH_VAPID_VAULT_PATH: z.string().default("secret/data/platform-notification/browser-push/vapid"),
  BROWSER_PUSH_VAPID_PUBLIC_KEY_VAULT_KEY: z.string().default("public_key"),
  VAULT_ADDR: z.string().default("http://vault.vault.svc.cluster.local:8200"),
  VAULT_TOKEN_FILE: z.string().default("/vault-secrets/vault-token"),
  TOKEN_CACHE_SECONDS: z.string().default("300"),
  OPENAPI_SERVER_URL: z.string().default("http://platform-notification-service.directus.svc.cluster.local:8080"),
  KAFKA_ENABLED: z.string().default("true"),
  KAFKA_BROKERS: z.string().default("kafka.kafka.svc.internal.lan:9092"),
  KAFKA_CLIENT_ID: z.string().default("platform-notification-service"),
  KAFKA_SSL: z.string().default("false"),
  KAFKA_SASL_MECHANISM: z.string().default("scram-sha-256"),
  KAFKA_USERNAME: z.string().default(""),
  KAFKA_USERNAME_VAULT_PATH: z.string().default("secret/data/kafka-nifi-username"),
  KAFKA_USERNAME_VAULT_KEY: z.string().default("value"),
  KAFKA_PASSWORD: z.string().default(""),
  KAFKA_PASSWORD_VAULT_PATH: z.string().default("secret/data/kafka-nifi-password"),
  KAFKA_PASSWORD_VAULT_KEY: z.string().default("value"),
  NOTIFICATION_REQUESTED_TOPIC: z.string().default("platform.notifications.requested.v1"),
  NOTIFICATION_REQUEST_COLLECTION: z.string().default("platform_notification_requests"),
  NOTIFICATION_DELIVERY_COLLECTION: z.string().default("platform_notification_delivery_attempts"),
  NOTIFICATION_BROWSER_SUBSCRIPTION_COLLECTION: z.string().default("platform_notification_browser_subscriptions"),
  PLATFORM_APPS_COLLECTION: z.string().default("platform_apps"),
  PLATFORM_ORGANIZATIONS_COLLECTION: z.string().default("platform_organizations")
});

const parsed = envSchema.parse(process.env);

function parseList(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function kafkaMechanism(value: string): "plain" | "scram-sha-256" | "scram-sha-512" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "plain" || normalized === "scram-sha-512") {
    return normalized;
  }
  return "scram-sha-256";
}

export const config = {
  port: Math.max(1, Math.min(65535, Number(parsed.PORT) || 8080)),
  trustProxyHops: Math.max(0, Number(parsed.TRUST_PROXY_HOPS) || 1),
  rateWindowMs: Math.max(1000, Number(parsed.RATE_WINDOW_MS) || 60_000),
  rateMax: Math.max(1, Number(parsed.RATE_MAX) || 120),
  requestTimeoutMs: Math.max(1000, Number(parsed.REQUEST_TIMEOUT_MS) || 10_000),
  authRequired: asBoolean(parsed.AUTH_REQUIRED, true),
  directusBaseUrl: parsed.DIRECTUS_BASE_URL.replace(/\/+$/, ""),
  directusHealthPath: parsed.DIRECTUS_HEALTH_PATH.startsWith("/")
    ? parsed.DIRECTUS_HEALTH_PATH
    : `/${parsed.DIRECTUS_HEALTH_PATH}`,
  directusStaticToken: parsed.DIRECTUS_STATIC_TOKEN,
  directusTokenVaultPath: parsed.DIRECTUS_TOKEN_VAULT_PATH,
  directusTokenVaultKey: parsed.DIRECTUS_TOKEN_VAULT_KEY,
  browserPushTrustedDirectusClientKeys: parseList(parsed.BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_KEYS),
  browserPushTrustedDirectusClientTokenVaultPrefix: parsed.BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_TOKEN_VAULT_PREFIX.replace(/\/+$/, ""),
  browserPushTrustedDirectusClientTokenVaultKey: parsed.BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_TOKEN_VAULT_KEY,
  internalToken: parsed.INTERNAL_TOKEN,
  internalTokenVaultPath: parsed.INTERNAL_TOKEN_VAULT_PATH,
  internalTokenVaultKey: parsed.INTERNAL_TOKEN_VAULT_KEY,
  browserPushVapidPublicKey: parsed.BROWSER_PUSH_VAPID_PUBLIC_KEY,
  browserPushVapidVaultPath: parsed.BROWSER_PUSH_VAPID_VAULT_PATH,
  browserPushVapidPublicKeyVaultKey: parsed.BROWSER_PUSH_VAPID_PUBLIC_KEY_VAULT_KEY,
  vaultAddr: parsed.VAULT_ADDR.replace(/\/+$/, ""),
  vaultTokenFile: parsed.VAULT_TOKEN_FILE,
  tokenCacheSeconds: Math.max(5, Number(parsed.TOKEN_CACHE_SECONDS) || 300),
  openApiServerUrl: parsed.OPENAPI_SERVER_URL,
  kafkaEnabled: asBoolean(parsed.KAFKA_ENABLED, true),
  kafkaBrokers: parseList(parsed.KAFKA_BROKERS),
  kafkaClientId: parsed.KAFKA_CLIENT_ID,
  kafkaSsl: asBoolean(parsed.KAFKA_SSL, false),
  kafkaSaslMechanism: kafkaMechanism(parsed.KAFKA_SASL_MECHANISM),
  kafkaUsername: parsed.KAFKA_USERNAME,
  kafkaUsernameVaultPath: parsed.KAFKA_USERNAME_VAULT_PATH,
  kafkaUsernameVaultKey: parsed.KAFKA_USERNAME_VAULT_KEY,
  kafkaPassword: parsed.KAFKA_PASSWORD,
  kafkaPasswordVaultPath: parsed.KAFKA_PASSWORD_VAULT_PATH,
  kafkaPasswordVaultKey: parsed.KAFKA_PASSWORD_VAULT_KEY,
  notificationRequestedTopic: parsed.NOTIFICATION_REQUESTED_TOPIC,
  notificationRequestCollection: parsed.NOTIFICATION_REQUEST_COLLECTION,
  notificationDeliveryCollection: parsed.NOTIFICATION_DELIVERY_COLLECTION,
  notificationBrowserSubscriptionCollection: parsed.NOTIFICATION_BROWSER_SUBSCRIPTION_COLLECTION,
  platformAppsCollection: parsed.PLATFORM_APPS_COLLECTION,
  platformOrganizationsCollection: parsed.PLATFORM_ORGANIZATIONS_COLLECTION
};
