# Project Status

## Completed Steps

* Defined the distributed order-processing scenario.
* Defined the main services and their responsibilities.
* Selected the initial technology stack.
* Preserved the complete integration and microservices testing scope.
* Created the local Git repository.
* Configured the `main` branch.
* Created the initial project documentation branch.

## Current Step

Establish the repository documentation baseline and create the first project commit.

## Next Steps

1. Document the initial system architecture.
2. Define the responsibilities and communication between services.
3. Create the repository folder structure.
4. Prepare the Docker Compose infrastructure.
5. Start PostgreSQL and RabbitMQ.
6. Implement the services incrementally.
7. Create the test plan and test strategy.
8. Implement API and integration tests.
9. Validate database consistency.
10. Test asynchronous events.
11. Implement contract validation.
12. Test idempotency, retry, timeout, and dependency failures.
13. Add execution evidence and reports.
14. Configure GitHub Actions.
15. Review the repository before publication.

## Pending Items

* Architecture documentation.
* Infrastructure configuration.
* Service implementation.
* Test documentation.
* Automated test implementation.
* CI pipeline.
* Execution evidence.
* Final README.
* Portuguese README version.

## Decisions

* The project will maintain its complete microservices testing scope.
* The application will simulate a realistic e-commerce order flow.
* Synchronous communication will use REST APIs.
* Asynchronous communication will use RabbitMQ.
* PostgreSQL will be used for persistent data.
* Docker Compose will provide a reproducible local environment.
* Tests and services will be implemented incrementally.
* Test results will never be documented as successful without actual execution evidence.

## Problems Found

No technical problems have been found yet.

## Project Learnings

* Testing a distributed system requires validating more than individual API responses.
* Quality must also cover service communication, database state, events, failures, retries, and traceability.
* Repository documentation should distinguish planned features from features that have already been implemented.
