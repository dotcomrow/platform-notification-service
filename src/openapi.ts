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
          notification_key: { type: "string" },
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
                type: { type: "string", enum: ["user", "role", "group", "organization", "app", "browser_subscription", "email", "phone", "topic", "webhook"] },
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
          parameters: { type: "object", additionalProperties: true },
          message: {
            type: "object",
            additionalProperties: true,
            properties: {
              subject: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              text: { type: "string" },
              html: { type: "string" },
              data: { type: "object", additionalProperties: true },
              options: { type: "object", additionalProperties: true }
            }
          },
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
      NotificationCanaryRequest: {
        type: "object",
        additionalProperties: true,
        properties: {
          channel: { type: "string", enum: ["in_app", "browser_push", "mobile_push", "email", "sms", "voice", "webhook"] },
          dry_run: { type: "boolean", default: true },
          send: { type: "boolean", default: false },
          notification_key: { type: "string" },
          recipient: { type: "object", additionalProperties: true },
          recipient_address: { type: "string" },
          parameters: { type: "object", additionalProperties: true },
          metadata: { type: "object", additionalProperties: true },
          timeout_ms: { type: "integer", minimum: 1000, maximum: 120000 },
          poll_interval_ms: { type: "integer", minimum: 250, maximum: 5000 }
        }
      },
      NotificationCanaryResponse: {
        type: "object",
        required: ["ok", "notification_request_id", "channel", "status"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          notification_request_id: { type: "string" },
          channel: { type: "string" },
          dry_run: { type: "boolean" },
          dry_run_observed: { type: "boolean" },
          status: { type: "string" },
          reason: { type: "string" },
          delivery_attempt_count: { type: "integer" },
          channel_delivery_attempt_count: { type: "integer" },
          delivery_attempts: { type: "array", items: { type: "object", additionalProperties: true } }
        }
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
      BrowserPushSubscriptionBrowseRequest: {
        type: "object",
        additionalProperties: true,
        properties: {
          query: { type: "string" },
          field: { type: "string", enum: ["all", "id", "user_id", "email", "name", "browser_installation_id", "source"] },
          name_prefix: { type: "string" },
          organization_id: { type: "string" },
          app_id: { type: "string" },
          source: { type: "string" },
          browser_installation_id: { type: "string" },
          status: { type: "string" },
          statuses: { type: "array", items: { type: "string" }, maxItems: 25 },
          permission: { type: "string", enum: ["granted", "denied", "default", "unsupported"] },
          persistent: { type: "boolean" },
          has_endpoint: { type: "boolean" },
          date_field: { type: "string", enum: ["last_seen_at", "date_created", "date_updated", "expiration_time"] },
          date_start: { type: "string", format: "date-time" },
          date_end: { type: "string", format: "date-time" },
          sort: {
            type: "string",
            enum: ["last_seen_at_desc", "last_seen_at_asc", "created_desc", "created_asc", "updated_desc", "updated_asc"]
          },
          limit: { type: "integer", minimum: 1, maximum: 250 },
          offset: { type: "integer", minimum: 0, maximum: 100000 },
          scan_limit: { type: "integer", minimum: 1, maximum: 20000 }
        }
      },
      BrowserPushSubscriptionBrowseResponse: {
        type: "object",
        required: ["ok", "browser_subscriptions", "count", "total_records", "matching_records"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          count: { type: "integer" },
          total_records: { type: "integer" },
          matching_records: { type: "integer" },
          matching_records_exact: { type: "boolean" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          next_offset: { type: "integer", nullable: true },
          scanned_records: { type: "integer" },
          scan_limit: { type: "integer" },
          scan_truncated: { type: "boolean" },
          browser_subscriptions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: true,
              properties: {
                id: { type: "string" },
                source: { type: "string", nullable: true },
                browser_installation_id: { type: "string", nullable: true },
                user_id: { type: "string", nullable: true },
                user_email: { type: "string", nullable: true },
                display_name: { type: "string", nullable: true },
                organization_id: { type: "string", nullable: true },
                app_id: { type: "string", nullable: true },
                status: { type: "string", nullable: true },
                permission: { type: "string", nullable: true },
                persistent: { type: "boolean", nullable: true },
                has_endpoint: { type: "boolean" },
                endpoint_hash_prefix: { type: "string", nullable: true },
                capability_reason: { type: "string", nullable: true },
                registration_status: { type: "string", nullable: true },
                fallback_required: { type: "boolean", nullable: true },
                disabled_by_user: { type: "boolean", nullable: true },
                last_seen_at: { type: "string", nullable: true },
                expiration_time: { type: "string", nullable: true },
                date_created: { type: "string", nullable: true },
                date_updated: { type: "string", nullable: true },
                user_agent: { type: "string", nullable: true },
                fallback_channels: { type: "array", nullable: true, items: { type: "string" } },
                notification_link: { type: "object", nullable: true, additionalProperties: true }
              }
            }
          }
        }
      },
      BrowserPushSubscriptionStatsRequest: {
        allOf: [
          { $ref: "#/components/schemas/BrowserPushSubscriptionBrowseRequest" },
          {
            type: "object",
            properties: {
              bucket: { type: "string", enum: ["hour", "day", "week"] }
            }
          }
        ]
      },
      BrowserPushSubscriptionStatsResponse: {
        type: "object",
        required: ["ok", "stats"],
        additionalProperties: true,
        properties: {
          ok: { type: "boolean" },
          stats: {
            type: "object",
            additionalProperties: true,
            properties: {
              total_records: { type: "integer" },
              matching_records: { type: "integer" },
              matching_records_exact: { type: "boolean" },
              scanned_records: { type: "integer" },
              scan_limit: { type: "integer" },
              scan_truncated: { type: "boolean" },
              unique_display_names: { type: "integer" },
              unique_browser_installations: { type: "integer" },
              unique_user_ids: { type: "integer" },
              unique_user_emails: { type: "integer" },
              status_counts: { type: "object", additionalProperties: { type: "integer" } },
              permission_counts: { type: "object", additionalProperties: { type: "integer" } },
              source_counts: { type: "object", additionalProperties: { type: "integer" } },
              persistent_counts: {
                type: "object",
                additionalProperties: true,
                properties: {
                  persistent: { type: "integer" },
                  non_persistent: { type: "integer" },
                  unknown: { type: "integer" }
                }
              },
              display_name_initial_counts: { type: "object", additionalProperties: { type: "integer" } },
              date_buckets: { type: "object", additionalProperties: { type: "integer" } }
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
    "/internal/canaries/notifications": {
      post: {
        operationId: "runNotificationCanary",
        summary: "Queue a notification through Kafka and verify the NiFi delivery flow reaches a terminal result.",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/NotificationCanaryRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "The notification canary reached a successful terminal delivery result.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotificationCanaryResponse" }
              }
            }
          },
          "503": {
            description: "The notification canary reached a failed terminal result.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotificationCanaryResponse" }
              }
            }
          },
          "504": {
            description: "The notification canary timed out before a terminal result was observed.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/NotificationCanaryResponse" }
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
    "/internal/browser-subscriptions/browse": {
      post: {
        operationId: "browseBrowserSubscriptions",
        summary: "Browse browser Web Push subscriptions with bounded paging and Directus-backed filters.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrowserPushSubscriptionBrowseRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "A bounded page of browser push subscriptions and paging metadata.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BrowserPushSubscriptionBrowseResponse" }
              }
            }
          }
        }
      }
    },
    "/internal/browser-subscriptions/stats": {
      post: {
        operationId: "getBrowserSubscriptionStats",
        summary: "Read bounded aggregate stats for browser Web Push subscriptions.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/BrowserPushSubscriptionStatsRequest" }
            }
          }
        },
        responses: {
          "200": {
            description: "Browser push subscription table stats for the supplied filters.",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BrowserPushSubscriptionStatsResponse" }
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
