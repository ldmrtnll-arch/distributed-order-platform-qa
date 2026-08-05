# Project Status

## Completed Steps

* Defined the distributed order-processing scenario.
* Defined the main services and their responsibilities.
* Selected the initial technology stack.
* Preserved the complete integration and microservices testing scope.
* Created the local Git repository.
* Configured the initial Git workflow.
* Created the documentation baseline.
* Selected a hybrid orchestration architecture.
* Defined synchronous REST communication between services.
* Defined asynchronous event communication through RabbitMQ.
* Defined logical database ownership for each service.
* Documented the successful, rejected, declined, and technical failure flows.
* Documented the initial idempotency, retry, timeout, compensation, and traceability requirements.

## Current Step

Review and commit the planned system architecture.

## Next Steps

1. Define the repository folder structure.
2. Verify the local development prerequisites.
3. Create the initial Node.js and TypeScript configuration.
4. Prepare the Docker Compose infrastructure.
5. Start PostgreSQL and RabbitMQ.
6. Implement the Order Service incrementally.
7. Implement the Inventory Service incrementally.
8. Implement the Payment Service incrementally.
9. Implement the Notification Service incrementally.
10. Create the test plan and test strategy.
11. Implement API and integration tests.
12. Validate database consistency.
13. Test asynchronous events.
14. Implement contract validation.
15. Test idempotency, retry, timeout, and dependency failures.
16. Add execution evidence and reports.
17. Configure GitHub Actions.
18. Review the repository before publication.

## Pending Items

* Repository source-code structure.
* Environment prerequisite verification.
* Infrastructure configuration.
* Service implementation.
* Database initialization.
* RabbitMQ configuration.
* Test documentation.
* Automated test implementation.
* CI pipeline.
* Execution evidence.
* Final README.
* Portuguese README version.

## Decisions

* The project will maintain its complete microservices testing scope.
* The application will simulate a realistic e-commerce order flow.
* The Order Service will orchestrate the main order workflow.
* Synchronous service communication will use REST APIs.
* Asynchronous domain communication will use RabbitMQ.
* Each service will own a logical PostgreSQL database.
* One PostgreSQL container may host the logical databases locally.
* Docker Compose will provide a reproducible development environment.
* Requests and events will propagate a correlation ID.
* Retryable operations will use idempotency protection.
* Inventory compensation will occur after payment failure or decline.
* Tests and services will be implemented incrementally.
* Test results will never be documented as successful without actual execution evidence.

## Problems Found

No technical implementation problems have been found yet.

The Git line-ending warnings are expected on Windows and do not indicate corrupted files or failed commits.

## Project Learnings

* Distributed system testing must validate the complete business workflow, not only isolated HTTP responses.
* Synchronous and asynchronous integrations introduce different failure and consistency risks.
* Idempotency protects the platform against duplicate processing caused by retries.
* Compensation is necessary when one step succeeds and a later step fails.
* Correlation IDs make an operation traceable across APIs, events, databases, and logs.
* Testability must be considered during system design rather than added only after implementation.
