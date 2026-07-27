# Epic 02 - Identity And Partner Access

## US-02.01 - Partner Application

Story ID: `US-02.01`
As a: 3rd Party Booking App
I want: to apply for platform access
So that: I can integrate with the GDS Partner API.

Acceptance Criteria:

- Given a partner submits legal and display information, when the request is valid, then a `Partner` is created with `ONBOARDING` status.
- Given the partner is created, when sandbox access is allowed, then sandbox approval metadata can be recorded.
- Given duplicate legal identity is detected, when application is submitted, then the system blocks duplicate onboarding.

Primary Module: `identity`
Supporting Modules: `admin`, `shared/db`
Data: `Partner`
API/UI: Developer portal application form; Admin partner review
Priority: `P0`
Notes: Production access requires additional go-live approval.

## US-02.02 - Sandbox API Key Issuance

Story ID: `US-02.02`
As an: Admin
I want: to issue sandbox API keys to approved partner applicants
So that: partners can test without affecting production inventory.

Acceptance Criteria:

- Given a partner is approved for sandbox, when keys are issued, then a `PartnerApiKey` is created with `SANDBOX` environment.
- Given a key is generated, when persisted, then only key prefix, key hash, and signing secret hash are stored.
- Given a sandbox key is used, when requests are authenticated, then all reads and writes are scoped to `SANDBOX`.
- Given a key is revoked or expired, when used, then authentication fails.

Primary Module: `identity`
Supporting Modules: `shared/auth`, `shared/db`
Data: `Partner`, `PartnerApiKey`
API/UI: Admin partner console; Developer portal key screen
Priority: `P0`
Notes: Sandbox and production keys may be active at the same time.

## US-02.03 - Partner API Authentication

Story ID: `US-02.03`
As a: Partner API client
I want: to authenticate each request with API key and HMAC signature
So that: the GDS can trust request origin and detect tampering.

Acceptance Criteria:

- Given a request has a valid API key and HMAC signature, when received, then `authenticatePartnerRequest()` resolves the partner, key, environment, and scopes.
- Given the signature is missing or invalid, when the request is processed, then the system returns an authentication error.
- Given a request timestamp is outside the allowed skew, when validated, then the request is rejected.
- Given authentication succeeds, when the request completes, then API usage is counted by partner, environment, and date.

Primary Module: `identity`
Supporting Modules: `shared/auth`, `shared/redis`, `shared/db`
Data: `PartnerApiKey`, `ApiUsageDaily`
API/UI: Partner API gateway middleware
Priority: `P0`
Notes: All partner-facing endpoints require this middleware. Usage metrics belong to observability infrastructure rather than Identity business data.

## US-02.04 - Webhook Endpoint Configuration

Story ID: `US-02.04`
As a: 3rd Party Booking App
I want: to configure webhook endpoints per environment
So that: I can receive booking and slot-conflict events.

Acceptance Criteria:

- Given a partner submits a webhook URL, when saved, then `WebhookEndpoint` is created for the partner and environment.
- Given the URL is already configured for that partner and environment, when submitted again, then duplicate creation is blocked.
- Given verification succeeds, when the endpoint is marked verified, then status becomes `ACTIVE`.
- Given an endpoint is disabled, when events are delivered, then disabled endpoints are skipped.

Primary Module: `identity`
Supporting Modules: `shared/communications`, `shared/db`
Data: `WebhookEndpoint`
API/UI: Developer portal webhook settings
Priority: `P1`
Notes: Identity owns endpoint configuration; Shared Communications reads only active, environment-matched endpoints for delivery.

## US-02.05 - Production Go-Live Approval

Story ID: `US-02.05`
As an: Admin
I want: to approve a partner for production only after readiness checks
So that: production inventory is protected from unsafe integrations.

Acceptance Criteria:

- Given a partner requests production access, when review starts, then admin can inspect KYC, webhook reachability, idempotency behavior, and usage history.
- Given BUSINESS KYC is not verified, when production key issuance is attempted, then it is blocked.
- Given go-live review succeeds, when production access is approved, then `production_approved_by` and `production_approved_at` are saved.
- Given approval exists, when keys are issued, then a `PRODUCTION` API key may be created without revoking sandbox keys.

Primary Module: `admin`
Supporting Modules: `identity`, `shared/communications`
Data: `Partner`, `PartnerApiKey`, `KycVerification`, `WebhookEndpoint`
API/UI: Admin partner go-live console
Priority: `P0`
Notes: Production key issuance is a gate, not a self-service action for v1.

## US-02.06 - Partner Usage Reporting

Story ID: `US-02.06`
As a: Partner
I want: to view my API usage and booking/settlement history
So that: I can monitor integration health and commercial performance.

Acceptance Criteria:

- Given a partner views usage, when a date range is selected, then request count, error count, rate-limit count, and p95 latency are returned.
- Given a partner requests booking reports, when authenticated, then only that partner's data is returned.
- Given environment is selected, when reports load, then sandbox and production data remain isolated.

Primary Module: `admin`
Supporting Modules: `identity`, `booking`, `financial-close`, `shared/observability`, `shared/db`
Data: `Partner`, `ApiUsageDaily`, `Booking`, `Settlement`, `Invoice`
API/UI: Developer portal reports; `GET /v1/reports/bookings`
Priority: `P1`
Notes: Admin provides the read-only reporting composition; each business module remains the source of truth for its data. Partner reports must never expose other partners' data.
