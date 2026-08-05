# Planned System Architecture

## 1. Purpose

This document describes the planned architecture of the Distributed Order Platform used in this Quality Assurance portfolio project.

The application will simulate a distributed e-commerce order workflow involving synchronous REST communication, asynchronous events, independent service data, partial failures, retries, idempotency, and distributed traceability.

The architecture is intentionally designed to expose realistic integration risks that can be investigated through manual and automated testing.

> The components described in this document are planned. Their implementation and execution evidence will be added incrementally.

## 2. Architecture Style

The platform will use a hybrid orchestration architecture.

The `order-service` will coordinate the main order workflow through synchronous REST requests to the inventory and payment services.

Each service will also publish domain events to RabbitMQ. Final order events will be consumed by the notification service.

This approach allows the project to test both synchronous and asynchronous communication without making the implementation too large for a junior-level portfolio project.

## 3. System Context

```mermaid
flowchart LR
    Client[API Client or Automated Test]

    Order[Order Service]
    Inventory[Inventory Service]
    Payment[Payment Service]
    Notification[Notification Service]

    RabbitMQ[(RabbitMQ)]

    OrdersDB[(Orders Database)]
    InventoryDB[(Inventory Database)]
    PaymentsDB[(Payments Database)]
    NotificationsDB[(Notifications Database)]

    Client -->|REST| Order

    Order -->|REST reservation request| Inventory
    Order -->|REST payment request| Payment

    Order -->|Order events| RabbitMQ
    Inventory -->|Inventory events| RabbitMQ
    Payment -->|Payment events| RabbitMQ

    RabbitMQ -->|Final order events| Notification

    Order --> OrdersDB
    Inventory --> InventoryDB
    Payment --> PaymentsDB
    Notification --> NotificationsDB
```

## 4. Planned Components

### 4.1 Order Service

The Order Service will be the entry point for creating and consulting orders.

Planned responsibilities:

* accept order creation requests;
* validate the initial order payload;
* prevent duplicate order creation using an idempotency key;
* persist the order and its current status;
* request an inventory reservation;
* request payment processing;
* coordinate compensation when a later step fails;
* publish order lifecycle events;
* propagate the correlation ID to dependencies;
* expose order information for tests and clients.

Planned endpoints:

| Method | Endpoint           | Purpose                     |
| ------ | ------------------ | --------------------------- |
| `POST` | `/orders`          | Create and process an order |
| `GET`  | `/orders/:orderId` | Retrieve an order           |
| `GET`  | `/health`          | Check service health        |

Initial order statuses:

* `PENDING`
* `PROCESSING`
* `CONFIRMED`
* `CANCELLED`

### 4.2 Inventory Service

The Inventory Service will manage products, available quantities, and reservations.

Planned responsibilities:

* verify whether a product exists;
* verify whether the requested quantity is available;
* create an inventory reservation;
* prevent duplicate reservations for the same order;
* release a reservation when compensation is required;
* publish inventory events;
* expose inventory and reservation data for validation.

Planned endpoints:

| Method   | Endpoint                 | Purpose                        |
| -------- | ------------------------ | ------------------------------ |
| `GET`    | `/inventory/:sku`        | Retrieve product stock         |
| `POST`   | `/reservations`          | Reserve inventory for an order |
| `DELETE` | `/reservations/:orderId` | Release an order reservation   |
| `GET`    | `/reservations/:orderId` | Retrieve a reservation         |
| `GET`    | `/health`                | Check service health           |

Initial reservation statuses:

* `RESERVED`
* `RELEASED`
* `REJECTED`

### 4.3 Payment Service

The Payment Service will simulate payment processing.

Planned responsibilities:

* receive payment requests;
* apply deterministic payment approval and rejection rules;
* prevent duplicate charges using an idempotency key;
* store payment attempts and their results;
* return business rejections separately from technical failures;
* publish payment events;
* expose payment data for validation.

Planned endpoints:

| Method | Endpoint             | Purpose                      |
| ------ | -------------------- | ---------------------------- |
| `POST` | `/payments`          | Process an order payment     |
| `GET`  | `/payments/:orderId` | Retrieve payment information |
| `GET`  | `/health`            | Check service health         |

Initial payment statuses:

* `APPROVED`
* `DECLINED`
* `FAILED`

No real payment provider or real financial transaction will be used.

### 4.4 Notification Service

The Notification Service will consume final order events asynchronously.

Planned responsibilities:

* consume confirmed and cancelled order events;
* create a notification record;
* avoid processing the same event more than once;
* preserve the event and correlation identifiers;
* retry transient consumer failures;
* route unprocessable messages to a dead-letter queue;
* expose stored notifications for test validation.

Planned endpoints:

| Method | Endpoint                  | Purpose                             |
| ------ | ------------------------- | ----------------------------------- |
| `GET`  | `/notifications/:orderId` | Retrieve notifications for an order |
| `GET`  | `/health`                 | Check service health                |

## 5. Main Order Flow

### 5.1 Successful Order

```mermaid
sequenceDiagram
    participant Client
    participant Order as Order Service
    participant Inventory as Inventory Service
    participant Payment as Payment Service
    participant Broker as RabbitMQ
    participant Notification as Notification Service

    Client->>Order: POST /orders
    Order->>Order: Store order as PENDING

    Order->>Inventory: POST /reservations
    Inventory->>Inventory: Reserve available stock
    Inventory-->>Order: Reservation accepted
    Inventory->>Broker: inventory.reserved

    Order->>Payment: POST /payments
    Payment->>Payment: Process payment
    Payment-->>Order: Payment approved
    Payment->>Broker: payment.approved

    Order->>Order: Update order to CONFIRMED
    Order->>Broker: order.confirmed
    Order-->>Client: Confirmed order response

    Broker->>Notification: Deliver order.confirmed
    Notification->>Notification: Store notification
```

Expected final state:

* order status is `CONFIRMED`;
* inventory remains reserved;
* payment status is `APPROVED`;
* an `order.confirmed` event exists;
* a confirmation notification is created;
* the same correlation ID can be traced across the operation.

### 5.2 Inventory Rejection

When inventory is unavailable:

1. The order is initially stored.
2. The inventory service rejects the reservation.
3. Payment must not be requested.
4. The order is updated to `CANCELLED`.
5. An `inventory.rejected` event is published.
6. An `order.cancelled` event is published.
7. A cancellation notification is eventually created.

### 5.3 Payment Decline

When payment is declined:

1. Inventory is successfully reserved.
2. Payment returns a business decline.
3. The order service requests the release of the reservation.
4. Inventory is restored.
5. The order is updated to `CANCELLED`.
6. A `payment.declined` event is published.
7. An `order.cancelled` event is published.
8. A cancellation notification is eventually created.

### 5.4 Technical Failure

When a dependency times out or returns a transient server error:

1. The order service applies its configured retry policy.
2. The same idempotency key must be reused in retry attempts.
3. A duplicate reservation or charge must not be created.
4. If retries are exhausted, the operation fails safely.
5. Any completed step must be compensated when necessary.
6. The final state must remain consistent and traceable.

## 6. Synchronous Communication

REST APIs will be used for synchronous communication.

Planned request headers:

| Header             | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `Content-Type`     | Defines the request media type                    |
| `Accept`           | Defines the expected response media type          |
| `X-Correlation-Id` | Identifies the complete distributed operation     |
| `Idempotency-Key`  | Prevents duplicate processing of retried requests |

The `X-Correlation-Id` received by the Order Service must be propagated to:

* Inventory Service requests;
* Payment Service requests;
* application logs;
* published RabbitMQ events;
* stored notification records.

When the client does not provide a correlation ID, the Order Service will generate one.

## 7. Asynchronous Communication

RabbitMQ will be used for asynchronous domain events.

Planned exchange:

```text
order.events
```

Planned routing keys:

* `order.created`
* `inventory.reserved`
* `inventory.rejected`
* `inventory.released`
* `payment.approved`
* `payment.declined`
* `payment.failed`
* `order.confirmed`
* `order.cancelled`

A common event envelope will be used:

```json
{
  "eventId": "uuid",
  "eventType": "order.confirmed",
  "eventVersion": 1,
  "occurredAt": "2026-08-05T12:00:00.000Z",
  "correlationId": "uuid",
  "aggregateId": "order-uuid",
  "source": "order-service",
  "data": {}
}
```

Important event validations will include:

* required fields;
* correct data types;
* supported event version;
* valid identifiers;
* correct routing key;
* correlation ID propagation;
* compatibility with JSON Schema;
* duplicate event handling;
* retry behavior;
* dead-letter routing.

## 8. Data Ownership

Each service will own its data.

For local development, a single PostgreSQL container may host multiple logical databases:

* `orders_db`
* `inventory_db`
* `payments_db`
* `notifications_db`

Services must not directly modify another service's database.

Automated database tests may connect directly to databases for validation, but this access is for testing and investigation only.

This separation allows the project to validate:

* service data ownership;
* eventual consistency;
* cross-service inconsistencies;
* compensation results;
* duplicate records;
* missing records;
* correct database constraints.

## 9. Idempotency

Idempotency will be required for operations that may be retried.

Planned examples:

* repeated `POST /orders` requests with the same `Idempotency-Key`;
* repeated reservation requests for the same order;
* repeated payment requests for the same order;
* repeated delivery of the same RabbitMQ event.

Expected behavior:

* the same logical operation is not executed twice;
* no duplicate order is created;
* stock is not reserved twice;
* payment is not charged twice;
* a notification is not created twice;
* repeated requests return a consistent response;
* conflicts between an idempotency key and a different payload are rejected.

## 10. Retry, Timeout, and Recovery

Retry policies will apply only to transient failures, such as:

* network errors;
* dependency timeouts;
* selected HTTP `5xx` responses;
* temporary RabbitMQ consumer failures.

Retries must not be applied blindly to:

* invalid input;
* authentication or authorization failures;
* inventory rejection;
* payment decline;
* other deterministic business errors.

Retry and timeout values will be configurable so they can be tested without introducing unnecessary fixed waits.

RabbitMQ consumers will use acknowledgements and dead-letter handling so that failed messages are not silently lost.

## 11. Observability and Traceability

Each service will produce structured logs.

Planned log fields:

* timestamp;
* log level;
* service name;
* operation;
* correlation ID;
* order ID, when available;
* event ID, when available;
* HTTP status or event result;
* error type;
* error message.

Sensitive values, payment details, secrets, and credentials must not be written to logs.

The project will validate that one order can be traced across services using the same correlation ID.

## 12. Main Quality Risks

The initial architecture introduces the following quality risks:

1. Duplicate orders caused by client retries.
2. Duplicate inventory reservations.
3. Duplicate payment processing.
4. Payment processing after inventory rejection.
5. Reserved stock not released after payment decline.
6. Order status inconsistent with inventory or payment data.
7. Lost or duplicated RabbitMQ events.
8. Notification created more than once.
9. Unsupported event contract versions.
10. Missing or changed response fields.
11. Incorrect retry of business errors.
12. Requests hanging because of missing timeouts.
13. Missing correlation IDs between services.
14. Sensitive information exposed in logs.
15. Partial system availability producing inconsistent states.

These risks will later be connected to test scenarios and test cases through a traceability matrix.

## 13. Planned Testability Features

The application will include features that make failures observable and reproducible:

* deterministic payment test rules;
* reusable seeded products;
* health endpoints;
* query endpoints for order, reservation, payment, and notification state;
* configurable retry and timeout values;
* structured logs;
* correlation IDs;
* idempotency keys;
* RabbitMQ management interface;
* isolated PostgreSQL databases;
* Docker Compose environment;
* database cleanup or reset scripts;
* reusable automated test data.

These features are part of the application design because software that cannot be observed or controlled is more difficult to test reliably.

## 14. Scope Boundaries

The first project version will not include:

* a graphical web interface;
* real credit card processing;
* real customer personal information;
* Kubernetes;
* cloud infrastructure;
* production-grade authentication;
* multiple regions;
* high-volume production performance targets.

These items are outside the initial scope so the project can focus on integration quality, resilience, messaging, databases, and automated testing.

## 15. Architecture Decisions Summary

* The Order Service will orchestrate the main workflow.
* REST will be used for synchronous dependency calls.
* RabbitMQ will be used for domain events and notifications.
* PostgreSQL will provide persistent service data.
* Each service will own its logical database.
* Idempotency will protect retryable operations.
* Correlation IDs will provide distributed traceability.
* Compensation will restore inventory after a failed payment.
* RabbitMQ consumers will handle duplicates and failed messages.
* All components will be executed locally through Docker Compose.
* Implementation and test evidence will be added incrementally.
