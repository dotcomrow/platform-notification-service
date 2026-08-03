# platform-notification-service

Internal API for platform communication requests.

This service is the intake boundary for notifications and general platform
communication. Callers submit an event/request, the service validates and
enriches it, persists the request in Directus, then publishes a normalized
message to Kafka for the NiFi communication flow.

## Flow

1. A platform service or app calls `POST /internal/notifications`.
2. The service validates the request shape and internal bearer auth.
3. If `app_id` or `organization_id` is present, the service loads app/org
   context from Directus.
4. The request is stored in `platform_notification_requests`.
5. A normalized event is published to `platform.notifications.requested.v1`.
6. NiFi consumes the event, performs additional validation, resolves templates
   and rules, and calls the delivery executor.
7. NiFi/executors call this service to update request status and write delivery
   attempts.

## API

- `GET /healthz`
- `GET /readyz`
- `GET /openapi.json`
- `POST /internal/notifications`
- `POST /internal/browser-subscriptions`
- `GET /internal/notifications/:id`
- `POST /internal/notifications/:id/status`
- `POST /internal/notifications/:id/delivery-attempts`

Example request:

```json
{
  "event_key": "platform.deployment.failed",
  "source": "platform-deploy-service",
  "severity": "error",
  "priority": "high",
  "app_id": "00000000-0000-0000-0000-000000000000",
  "template_key": "platform-deployment-failed",
  "channels": ["in_app", "email"],
  "recipients": [
    {
      "type": "role",
      "id": "platform-admin"
    }
  ],
  "data": {
    "operation_id": "00000000-0000-0000-0000-000000000000",
    "step": "prod-deploy"
  },
  "metadata": {
    "correlation_source": "deployment"
  }
}
```

## Kafka Event

Default topic:

```text
platform.notifications.requested.v1
```

The published event includes:

- `schema_version`
- `notification_request_id`
- `event_key`
- `source`
- `severity`
- `priority`
- `organization_id`
- `app_id`
- `actor_user_id`
- `template_key`
- `locale`
- `channels`
- `recipients`
- `data`
- `metadata`
- `context`
- `dedupe_key`
- `idempotency_key`
- `correlation_id`
- `scheduled_for`
- `expires_at`
- `requested_at`

## Expected Directus Collections

The service expects these managed collections to exist. The collection names are
configurable through environment variables.

`platform_notification_requests`:

- `id`
- `event_key`
- `source`
- `severity`
- `priority`
- `status`
- `organization_id`
- `app_id`
- `actor_user_id`
- `template_key`
- `locale`
- `subject_hint`
- `body_hint`
- `requested_channels_json`
- `recipients_json`
- `data_json`
- `metadata_json`
- `context_json`
- `dedupe_key`
- `idempotency_key`
- `correlation_id`
- `scheduled_for`
- `expires_at`
- `requested_at`
- `queued_at`
- `started_at`
- `finished_at`
- `queue_topic`
- `last_message`
- `error_message`
- `result_json`

`platform_notification_delivery_attempts`:

- `id`
- `notification_request_id`
- `channel`
- `provider_key`
- `recipient_json`
- `message_json`
- `status`
- `provider_message_id`
- `request_payload_json`
- `response_json`
- `error_message`
- `attempted_at`
- `finished_at`

`platform_notification_browser_subscriptions`:

- `id`
- `source`
- `browser_installation_id`
- `endpoint`
- `endpoint_hash`
- `expiration_time`
- `p256dh`
- `auth`
- `user_id`
- `user_email`
- `user_phone`
- `organization_id`
- `app_id`
- `permission`
- `capabilities_json`
- `fallback_channels_json`
- `user_agent`
- `metadata_json`
- `status`
- `last_seen_at`

Future collection set:

- `platform_notification_templates`
- `platform_notification_template_versions`
- `platform_notification_preferences`
- `platform_notification_suppression_entries`
- `platform_notification_rule_bindings`
- `platform_notification_channels`

## Configuration

Important environment variables:

- `DIRECTUS_BASE_URL`
- `DIRECTUS_TOKEN_VAULT_PATH`
- `BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_KEYS`
- `BROWSER_PUSH_TRUSTED_DIRECTUS_CLIENT_TOKEN_VAULT_PREFIX`
- `BROWSER_SUBSCRIPTION_CLEANUP_ENABLED`
- `BROWSER_SUBSCRIPTION_CLEANUP_INTERVAL_MS`
- `BROWSER_SUBSCRIPTION_STALE_DAYS`
- `BROWSER_SUBSCRIPTION_CLEANUP_LIMIT`
- `INTERNAL_TOKEN_VAULT_PATH`
- `KAFKA_BROKERS`
- `KAFKA_USERNAME_VAULT_PATH`
- `KAFKA_PASSWORD_VAULT_PATH`
- `NOTIFICATION_REQUESTED_TOPIC`
- `NOTIFICATION_REQUEST_COLLECTION`
- `NOTIFICATION_DELIVERY_COLLECTION`
- `NOTIFICATION_BROWSER_SUBSCRIPTION_COLLECTION`

No provider tokens or credentials should be committed to this repo. Runtime
credentials are resolved from Vault.

## Local Build

```bash
npm install
npm run build
```
