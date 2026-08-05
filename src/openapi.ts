import { config } from "./config.js";

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "Platform Notification API",
    version: "1.0.0",
    description: "Internal request API for platform communication events."
  },
  servers: [{ url: config.openApiServerUrl }],
  components: {
    schemas: {
      NotificationRequest: {
        type: "object",
        required: ["event_key"],
        additionalProperties: true,
        properties: {
          event_key: { type: "string", example: "platform.deployment.failed" },
          source: { type: "string", example: "platform-deploy-service" },
          severity: { type: "string", enum: ["debug", "info", "success", "warning", "error", "critical"] },
          priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
          organization_id: { type: "string" },
          app_id: { type: "string" },
          actor_user_id: { type: "string" },
          template_key: { type: "string" },
          locale: { type: "string" },
          channels: {
            type: "array",
            items: { type: "string", enum: ["in_app", "browser_push", "mobile_push", "email", "sms", "voice", "webhook"] }
          },
          recipients: {
            type: "array",
            items: {
              type: "object",
              required: ["type"],
              additionalProperties: true,
              properties: {
                type: { type: "string", enum: ["user", "role", "group", "organization", "app", "email", "phone", "topic", "webhook"] },
                id: { type: "string" },
                address: { type: "string" },
                channels: { type: "array", items: { type: "string" } },
                locale: { type: "string" },
                data: { type: "object", additionalProperties: true }
              }
            }
          },
          subject: { type: "string" },
          body: { type: "string" },
          data: { type: "object", additionalProperties: true },
          metadata: { type: "object", additionalProperties: true },
          dedupe_key: { type: "string" },
          idempotency_key: { type: "string" },
          correlation_id: { type: "string" },
          scheduled_for: { type: "string", format: "date-time" },
          expires_at: { type: "string", format: "date-time" }
        }
      },
      NotificationRequestResponse: {
        type: "object",
        required: ["ok", "notification_request_id", "status", "queue_topic"],
        properties: {
          ok: { type: "boolean" },
          duplicate: { type: "boolean" },
          notification_request_id: { type: "string" },
          status: { type: "string" },
          correlation_id: { type: "string" },
          queue_topic: { type: "string" }
        },
        additionalProperties: true
      },
      NotificationStatusPatch: {
        type: "object",
        required: ["status"],
        additionalProperties: true,
        properties: {
          status: { type: "string", enum: ["queued", "processing", "sent", "partially_sent", "failed", "canceled"] },
          message: { type: "string" },
          result_json: { type: "object", additionalProperties: true },
          error_message: { type: "string" },
          started_at: { type: "string", format: "date-time" },
          finished_at: { type: "string", format: "date-time" }
        }
      },
      DeliveryAttempt: {
        type: "object",
        required: ["channel", "recipient_json", "status"],
        additionalProperties: true,
        properties: {
          channel: { type: "string", enum: ["in_app", "browser_push", "mobile_push", "email", "sms", "voice", "webhook"] },
          provider_key: { type: "string" },
          recipient_json: { type: "object", additionalProperties: true },
          message_json: { type: "object", additionalProperties: true },
          status: { type: "string", enum: ["queued", "sending", "sent", "failed", "skipped"] },
          provider_message_id: { type: "string" },
          request_payload_json: { type: "object", additionalProperties: true },
          response_json: { type: "object", additionalProperties: true },
          error_message: { type: "string" }
        }
      },
      BrowserPushSubscriptionRequest: {
        type: "object",
        required: ["permission", "supported", "capabilities"],
        additionalProperties: true,
        properties: {
          source: { type: "string" },
          browser_subscription_id: { type: "string" },
          browser_installation_id: { type: "string" },
          user_id: { type: "string" },
          user_email: { type: "string" },
          user_phone: { type: "string" },
          user_agent: { type: "string" },
          organization_id: { type: "string" },
          app_id: { type: "string" },
          permission: { type: "string", enum: ["granted", "denied", "default", "unsupported"] },
          supported: { type: "boolean" },
          capabilities: { type: "object", additionalProperties: true },
          metadata: { type: "object", additionalProperties: true },
          fallback_channels: { type: "array", items: { type: "string", enum: ["email", "sms"] } },
          subscription: {
            type: "object",
            required: ["endpoint", "keys"],
            properties: {
              endpoint: { type: "string", format: "uri" },
              expirationTime: { type: "number", nullable: true },
              keys: {
                type: "object",
                required: ["p256dh", "auth"],
                properties: {
                  p256dh: { type: "string" },
                  auth: { type: "string" }
                }
              }
            }
          }
        }
      },
      BrowserPushSubscriptionLifecycleRequest: {
        type: "object",
        required: ["status"],
        additionalProperties: true,
        properties: {
          status: { type: "string", enum: ["active", "disabled", "expired", "fallback", "inactive", "missing_subscription", "stale", "superseded"] },
          reason: { type: "string" },
          message: { type: "string" },
          provider_status_code: { type: "integer" },
          metadata: { type: "object", additionalProperties: true }
        }
      },
      BrowserPushSubscriptionSearchRequest: {
        type: "object",
        required: ["organization_id", "app_id"],
        additionalProperties: true,
        properties: {
          query: { type: "string" },
          field: { type: "string", enum: ["all", "id", "user_id", "email", "name"] },
          organization_id: { type: "string" },
          app_id: { type: "string" },
          status: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 100 }
        }
      },
      BrowserPushSubscriptionSearchResponse: {
        type: "object",
        required: ["ok", "browser_subscriptions", "count"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          count: { type: "integer" },
          browser_subscriptions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                browser_installation_id: { type: "string", nullable: true },
                user_id: { type: "string", nullable: true },
                user_email: { type: "string", nullable: true },
                display_name: { type: "string", nullable: true },
                organization_id: { type: "string", nullable: true },
                app_id: { type: "string", nullable: true },
                status: { type: "string", nullable: true },
                permission: { type: "string", nullable: true },
                last_seen_at: { type: "string", nullable: true },
                date_created: { type: "string", nullable: true },
                date_updated: { type: "string", nullable: true }
              }
            }
          }
        }
      },
      BrowserPushSubscriptionResponse: {
        type: "object",
        required: ["ok", "browser_subscription_id", "status"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          browser_subscription_id: { type: "string", nullable: true },
          status: { type: "string" },
          permission: { type: "string" },
          fallback_channels: { type: "array", items: { type: "string" } }
        }
      },
      BrowserPushPublicKeyResponse: {
        type: "object",
        required: ["ok", "public_key"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          public_key: { type: "string" }
        }
      },
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              message: { type: "string" },
              status: { type: "integer" }
            }
          }
        }
      }
    },
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer"
      }
    }
  },
  security: [{ bearerAuth: [] }],
  paths: {
    "/healthz": {
      get: {
        security: [],
        responses: {
          "200": { description: "Service is alive." }
        }
      }
    },
    "/readyz": {
      get: {
        security: [],
        responses: {
          "200": { description: "Service dependencies are available." },
          "503": { description: "A dependency is unavailable." }
        }
      }
    },
    "/internal/notifications": {
      post: {
        operationId: "queueNotification",
        summary: "Accept and queue a platform notification request.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NotificationRequest" }
            }
          }
        },
        responses: {
          "202": {
            description: "Notification request was accepted and queued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotificationRequestResponse" }
              }
            }
          },
          "200": {
            description: "An idempotent duplicate was already queued.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotificationRequestResponse" }
              }
            }
          }
        }
      }
    },
    "/internal/browser-subscriptions": {
      post: {
        operationId: "upsertBrowserSubscription",
        summary: "Register or refresh a browser Web Push subscription.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrowserPushSubscriptionRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Browser push subscription was stored.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BrowserPushSubscriptionResponse" }
              }
            }
          }
        }
      }
    },
    "/internal/browser-subscriptions/{id}/lifecycle": {
      post: {
        operationId: "patchBrowserSubscriptionLifecycle",
        summary: "Update browser Web Push subscription lifecycle status.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrowserPushSubscriptionLifecycleRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Browser push subscription lifecycle was updated.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BrowserPushSubscriptionResponse" }
              }
            }
          }
        }
      }
    },
    "/internal/browser-subscriptions/search": {
      post: {
        operationId: "searchBrowserSubscriptions",
        summary: "Search active browser Web Push subscriptions for a selected platform app.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrowserPushSubscriptionSearchRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Browser push subscriptions matching the scoped search.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BrowserPushSubscriptionSearchResponse" }
              }
            }
          }
        }
      }
    },
    "/internal/browser-push/public-key": {
      post: {
        operationId: "getBrowserPushPublicKey",
        summary: "Read the VAPID public key used for browser Web Push subscriptions.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { type: "object", additionalProperties: true }
            }
          }
        },
        responses: {
          "200": {
            description: "Browser push VAPID public key.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BrowserPushPublicKeyResponse" }
              }
            }
          },
          "503": { description: "Browser push VAPID public key is not configured." }
        }
      }
    },
    "/internal/notifications/{id}": {
      get: {
        summary: "Read a notification request and its stored context.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Notification request." },
          "404": { description: "Notification request was not found." }
        }
      }
    },
    "/internal/notifications/{id}/status": {
      post: {
        summary: "Update notification request status from NiFi or worker callbacks.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NotificationStatusPatch" }
            }
          }
        },
        responses: {
          "200": { description: "Status was updated." }
        }
      }
    },
    "/internal/notifications/{id}/delivery-attempts": {
      post: {
        summary: "Record a channel delivery attempt.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/DeliveryAttempt" }
            }
          }
        },
        responses: {
          "200": { description: "Delivery attempt was recorded." }
        }
      }
    }
  }
};
