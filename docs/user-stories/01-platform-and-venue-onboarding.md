# Epic 01 - Identity And Venue Onboarding

## US-01.01 - Venue Partner Registration

Story ID: `US-01.01`
As a: Venue Partner
I want: to register my owner account and create an initial venue profile
So that: I can start onboarding my turf business into the GDS.

Acceptance Criteria:

- Given a new Venue Partner submits legal name, email, phone, password, and venue details, when the request is valid, then `VenueOwner`, `Venue`, and `VenueOwnerMembership` records are created through their owning modules.
- Given the owner email is already used, when registration is submitted, then the system rejects the request without creating duplicate identity records.
- Given the venue is created during onboarding, when the record is persisted,
  then its authoritative status is `PENDING` and its currency is `INR`.
- Given the first owner membership is created, when the venue is persisted, then the creator receives `OWNER` role.

Primary Module: `identity`
Supporting Modules: `venue`, `shared/auth`, `shared/db`
Data: `VenueOwner`, `Venue`, `VenueOwnerMembership`
API/UI: Owner Dashboard registration flow
Priority: `P0`
Notes: Venue is not bookable until approved and configured.

## US-01.02 - Venue Partner Login

Story ID: `US-01.02`
As a: Venue Partner
I want: to log in securely to the Owner Dashboard
So that: I can manage only the venues I am authorized to operate.

Acceptance Criteria:

- Given valid credentials for an active owner, when login succeeds, then a hashed session document is appended to the bounded `VenueOwner.sessions` array and the raw token is returned once.
- Given invalid credentials, when login fails repeatedly, then `failed_login_count` increases and the account may be locked until `locked_until`.
- Given an expired or revoked session, when an Owner Dashboard request is made, then the request is rejected.
- Given an active session, when the owner accesses a venue, then membership is checked before returning venue data.

Primary Module: `identity`
Supporting Modules: `shared/auth`, `shared/db`
Data: `VenueOwner`, `VenueOwner.sessions`, `VenueOwnerMembership`
API/UI: Owner Dashboard login
Priority: `P0`
Notes: Permission checks must use `requirePermission()`.

## US-01.03 - Submit KYC Documents

Story ID: `US-01.03`
As a: Venue Partner
I want: to submit KYC documents during onboarding
So that: the platform can verify my identity and business before enabling production payouts.

Acceptance Criteria:

- Given a Venue Partner uploads a supported document, when the upload succeeds, then Shared Media returns protected object metadata that Identity embeds in `KycDocument.file`.
- Given documents are attached to a verification, when KYC is submitted, then Identity creates `KycVerification` and related `KycDocument` records.
- Given multiple verification attempts exist, when current KYC status is requested, then the verification marked `is_current` for the subject and verification type is the source of truth.
- Given a document is rejected, when rejection is saved, then a rejection reason is required.

Primary Module: `identity`
Supporting Modules: `shared/media`, `shared/db`
Data: `KycVerification`, `KycDocument`, `VenueOwner`
API/UI: Owner Dashboard KYC submission
Priority: `P0`
Notes: Identity owns KYC and document metadata; Shared Media owns only file-byte transport and protected access.

## US-01.04 - Add Venue Payout Account

Story ID: `US-01.04`
As a: Venue Partner
I want: to add a payout account using secure tokenized bank storage
So that: I can receive venue payouts without raw bank account data being stored in GDS.

Acceptance Criteria:

- Given payout account details are submitted, when tokenization succeeds, then only `vault_provider`, `vault_account_token`, and `account_last4` are persisted.
- Given verification has not completed, when the account is saved, then status is `PENDING`.
- Given penny-drop or manual verification succeeds, when admin confirms the account, then status becomes `VERIFIED`.
- Given verification fails, when the result is saved, then `verification_failure_reason` is required.

Primary Module: `venue`
Supporting Modules: `identity`, `admin`, `shared/db`
Data: `VenuePayoutAccount`, `AdminUser`, `KycVerification`
API/UI: Owner Dashboard payout account screen; Admin verification screen
Priority: `P0`
Notes: Raw account numbers must never be persisted.

## US-01.05 - Admin Approves Venue

Story ID: `US-01.05`
As an: Admin
I want: to review Venue User KYC and venue details
So that: only valid venues become active on the GDS.

Acceptance Criteria:

- Given an admin reviews KYC documents, when approved, then current KYC status becomes `VERIFIED`.
- Given a venue is approved, when all required gates pass, then `Venue.status` becomes `ACTIVE`.
- Given current owner KYC is not `VERIFIED`, when venue approval is attempted, then activation is blocked with a clear reason.
- Given a payout account is still pending, when the venue is otherwise approved, then venue activation may proceed but Financial Close must block payout.
- Given an admin approves a venue owner, when the action is saved, then `approved_by` and `approved_at` are recorded.

Primary Module: `admin`
Supporting Modules: `identity`, `venue`
Data: `VenueOwner`, `Venue`, `KycVerification`, `AdminUser`
API/UI: Admin onboarding console; `POST /api/v1/admin/onboarding/venues/{venueId}/approve`
Priority: `P0`
Notes: Admin orchestrates Identity and Venue public capabilities; it owns no business data.
