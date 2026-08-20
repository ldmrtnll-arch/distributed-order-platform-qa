# Planned System Architecture

## 1. Purpose

This document describes the planned architecture of the Distributed Order Platform used in this Quality Assurance portfolio project.

The application will simulate a distributed e-commerce order workflow involving synchronous REST communication, asynchronous events, independent service data, partial failures, retries, idempotency, and distributed traceability.

The architecture is intentionally designed to expose realistic integration risks that can be investigated through manual and automated testing.

> Current implementation boundary: Inventory, Payment, and Order are implemented as independent services. The Order workflow currently integrates only with Inventory through synchronous REST. Payment orchestration, RabbitMQ events, compensation, and Notification Service remain planned.

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

Implemented responsibilities in the current increment:

* accept order creation requests;
* validate the initial order payload;
* prevent duplicate order creation using an idempotency key;
* persist the order and its current status;
* request an inventory reservation;
* propagate the correlation ID to dependencies;
* distinguish terminal Inventory business rejection from recoverable technical failure.

Payment processing, compensation, event publication, and order-query endpoints remain planned.

Endpoints:

| Method | Endpoint           | Purpose                              | Status      |
| ------ | ------------------ | ------------------------------------ | ----------- |
| `POST` | `/orders`          | Create and process the Inventory step | Implemented |
| `GET`  | `/orders/:orderId` | Retrieve an order                    | Planned     |
| `GET`  | `/health`          | Check service health                 | Implemented |

Order statuses used by the implemented Inventory stage:

* `PENDING`
* `INVENTORY_RESERVED`
* `INVENTORY_REJECTED`

### 4.2 Inventory Service

The Inventory Service will manage products, available quantities, and reservations.

Implemented responsibilities:

* verify whether a product exists;
* verify whether the requested quantity is available;
* create an inventory reservation;
* prevent duplicate reservations for the same order;
* release a reservation when compensation is required;
* expose inventory and reservation data for validation.

Inventory event publication remains planned.

Implemented endpoints:

| Method | Endpoint                               | Purpose                        |
| ------ | -------------------------------------- | ------------------------------ |
| `GET`  | `/inventory/:sku`                      | Retrieve product stock         |
| `POST` | `/reservations`                        | Reserve inventory for an order |
| `POST` | `/reservations/:reservationId/release` | Release an order reservation   |
| `GET`  | `/health`                              | Check service health           |

Initial reservation statuses:

* `RESERVED`
* `RELEASED`
* `REJECTED`

### 4.3 Payment Service

The Payment Service will simulate payment processing.

Implemented responsibilities as an independent service:

* receive payment requests;
* apply deterministic payment approval and rejection rules;
* prevent duplicate charges using an idempotency key;
* store payment attempts and their results;
* return business rejections separately from technical failures;
* expose payment data for validation.

Order orchestration and payment event publication remain planned.

Endpoints:

| Method | Endpoint             | Purpose                      | Status      |
| ------ | -------------------- | ---------------------------- | ----------- |
| `POST` | `/payments`          | Process an order payment     | Implemented |
| `GET`  | `/payments/:orderId` | Retrieve payment information | Planned     |
| `GET`  | `/health`            | Check service health         | Implemented |

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

### 5.1 Implemented Inventory stage

The implemented flow persists the Order as `PENDING` and synchronously calls `POST /reservations` in Inventory. The dependency request uses `order:<orderId>:inventory-reservation` as its internal `Idempotency-Key` and propagates the current request's `X-Correlation-Id`.

```mermaid
sequenceDiagram
    participant Client
    participant Order as Order Service
    participant OrdersDB as orders_db
    participant Inventory as Inventory Service
    participant InventoryDB as inventory_db

    Client->>Order: POST /orders
    Order->>OrdersDB: Persist PENDING
    Order->>Inventory: POST /reservations
    Inventory->>InventoryDB: Create idempotent reservation
    Inventory-->>Order: Reserved or business rejection
    Order->>OrdersDB: Persist terminal Inventory state
    Order-->>Client: Order response
```

The state semantics are:

* `PENDING`: the Inventory stage is unfinished and remains recoverable;
* `INVENTORY_RESERVED`: the reservation completed and its identifier is stored on the Order;
* `INVENTORY_REJECTED`: Inventory returned a recognized terminal business outcome, either unknown SKU or insufficient stock.

Network failure, timeout, an unexpected `409`, or an invalid success body returns `ORDER_INVENTORY_UNAVAILABLE` while preserving `PENDING`. A client replay with the same payload and external `Idempotency-Key` reuses the same Order. Correlation ID is intentionally excluded from the request fingerprint, so recovery can use a new value. The Order Service currently makes one Inventory request per client attempt and has no automatic retry.

### 5.2 Planned complete successful order

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

### 5.3 Inventory Rejection

In the implemented Inventory stage, a recognized business rejection behaves as follows:

1. The order is initially stored.
2. Inventory reports an unknown SKU or insufficient stock.
3. Payment must not be requested.
4. The order is updated to `INVENTORY_REJECTED` with the public failure code.

Cancellation events and notifications remain planned.

### 5.4 Planned Payment Decline

When payment is declined:

1. Inventory is successfully reserved.
2. Payment returns a business decline.
3. The order service requests the release of the reservation.
4. Inventory is restored.
5. The order is updated to `CANCELLED`.
6. A `payment.declined` event is published.
7. An `order.cancelled` event is published.
8. A cancellation notification is eventually created.

### 5.5 Technical Failure

For the implemented Inventory stage, when the dependency is unreachable, times out, or returns an unexpected response:

1. The Order remains `PENDING`.
2. The client receives a safe `503 ORDER_INVENTORY_UNAVAILABLE` response.
3. No automatic retry is performed in the same request.
4. Recovery reuses the original payload and external `Idempotency-Key`.
5. Inventory's internal idempotency key prevents duplicate stock reservation.
6. Cross-database validation confirms one Order, one reservation, and one stock increment.

## 6. Synchronous Communication

REST APIs will be used for synchronous communication.

Planned request headers:

| Header             | Purpose                                           |
| ------------------ | ------------------------------------------------- |
| `Content-Type`     | Defines the request media type                    |
| `Accept`           | Defines the expected response media type          |
| `X-Correlation-Id` | Identifies the complete distributed operation     |
| `Idempotency-Key`  | Prevents duplicate processing of retried requests |

The `X-Correlation-Id` received by the Order Service is currently propagated to:

* Inventory Service requests;
* Order and Inventory structured logs for the relevant request.

Propagation to Payment, RabbitMQ events, and Notification remains planned.

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

The Order-to-Inventory HTTP request has a configurable timeout through `INVENTORY_REQUEST_TIMEOUT_MS`. The current Order client does not retry automatically. After a technical failure, the persisted `PENDING` Order is recovered through a new client request using the same external idempotency key and payload.

Future retry policies may apply only to transient failures, such as:

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
