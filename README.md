# Distributed Order Platform QA

Quality Assurance portfolio project focused on testing a distributed order-processing platform composed of REST APIs, databases, asynchronous messages, and external service dependencies.

## Project Status

This project is currently in the planning and environment setup phase.

The test documentation, infrastructure, services, automated tests, execution evidence, and CI pipeline will be developed incrementally.

## System Scenario

The application simulates an e-commerce order workflow distributed across multiple services:

* Order Service
* Inventory Service
* Payment Service
* Notification Service
* PostgreSQL databases
* RabbitMQ message broker

A customer creates an order, the inventory is reserved, the payment is processed, and events are published for the other services.

## Planned Test Coverage

The project will include:

* API testing
* Integration testing
* Contract testing
* Database testing
* Asynchronous messaging testing
* Idempotency testing
* Retry and timeout validation
* Dependency failure testing
* Data consistency validation
* Correlation ID and log validation
* Basic performance testing
* Continuous integration

## Planned Technologies

* Node.js
* TypeScript
* Playwright
* PostgreSQL
* RabbitMQ
* Docker
* Docker Compose
* JSON Schema
* Ajv
* k6
* GitHub Actions

## Main Quality Risks

The project will investigate risks commonly found in distributed systems, including:

* duplicated orders or messages;
* inconsistent data between services;
* unavailable dependencies;
* delayed event processing;
* incompatible API or event contracts;
* incorrect retry behavior;
* missing request traceability;
* partial failures during order processing.

## Repository Structure

The repository structure will be expanded incrementally as each project phase is implemented.

```text
distributed-order-platform-qa/
├── docs/
│   └── project-status.md
├── .gitignore
└── README.md
```

## Current Phase

Repository initialization and project documentation.
