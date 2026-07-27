typeface: clean
colorMode: pastel
styleMode: plain
direction: right

title Turf Booking GDS - MongoDB Only Collection ERD v0.9

notation crows-foot

// ERD v0.9 source-aligned export.
// References are application-validated ObjectIds, not MongoDB foreign keys.
// Embedded arrays are bounded to protect the 16 MB document limit.

// IDENTITY

AdminUser [icon: user-cog, color: purple] {
  _id objectId pk
  email string unique
  password_hash string
  display_name string
  role enum {ADMIN, OPS, SUPPORT}
  status enum {ACTIVE, DISABLED}
  fcm_tokens document[]
  last_login_at date nullable
  created_at date
  updated_at date
}

VenueOwner [icon: users, color: purple] {
  _id objectId pk
  legal_name string
  email string unique
  phone_e164 string
  password_hash string
  email_verified_at date nullable
  status enum {PENDING, ACTIVE, SUSPENDED}
  sessions document[]
  fcm_tokens document[]
  notifications document[]
  approved_by objectId ref AdminUser nullable
  approved_at date nullable
  created_at date
  updated_at date
  // sessions contain token_hash, IP/user-agent metadata, expiry and revocation
  // notifications are a bounded durable dashboard inbox
}

VenueOwnerMembership [icon: link, color: purple] {
  _id objectId pk
  owner_id objectId ref VenueOwner
  venue_id objectId ref Venue
  role enum {OWNER, MANAGER, STAFF}
  status enum {ACTIVE, REVOKED}
  created_at date
  updated_at date
  // Unique: owner_id + venue_id
}

VenueRolePermission [icon: shield, color: purple] {
  _id objectId pk
  role enum {OWNER, MANAGER, STAFF}
  permission enum {MANAGE_VENUE, MANAGE_COURTS, MANAGE_PRICING, MANAGE_MEMBERS, MANAGE_KYC, VIEW_FINANCE, VIEW_BOOKINGS, MANAGE_AVAILABILITY}
  created_at date
  // Unique: role + permission
}

KycVerification [icon: badge-check, color: purple] {
  _id objectId pk
  subject_type enum {VENUE_OWNER, PARTNER}
  subject_id objectId
  verification_type string
  status enum {DRAFT, SUBMITTED, IN_REVIEW, VERIFIED, REJECTED, EXPIRED}
  is_current boolean
  submitted_at date nullable
  reviewed_by objectId ref AdminUser nullable
  reviewed_at date nullable
  rejection_reason string nullable
  expires_at date nullable
  created_at date
  updated_at date
  // Partial unique: subject_type + subject_id + verification_type where is_current
}

KycDocument [icon: file-text, color: purple] {
  _id objectId pk
  kyc_verification_id objectId ref KycVerification
  document_type string
  file document
  status enum {ACTIVE, REJECTED, DELETED}
  created_at date
  updated_at date
  // file embeds storage_key, checksum, MIME/size and protected-access metadata
}

Partner [icon: briefcase, color: blue] {
  _id objectId pk
  legal_name string
  display_name string
  email string unique
  status enum {ONBOARDING, SANDBOX, ACTIVE, SUSPENDED}
  integration_review_status enum {NOT_STARTED, PENDING, PASSED, FAILED}
  production_approved_by objectId ref AdminUser nullable
  production_approved_at date nullable
  created_at date
  updated_at date
}

PartnerApiKey [icon: key, color: blue] {
  _id objectId pk
  partner_id objectId ref Partner
  environment enum {SANDBOX, PRODUCTION}
  key_prefix string unique
  secret_hash string
  status enum {ACTIVE, REVOKED}
  last_used_at date nullable
  expires_at date nullable
  created_at date
  revoked_at date nullable
}

ApiUsageDaily [icon: activity, color: blue] {
  _id objectId pk
  partner_id objectId ref Partner
  environment enum {SANDBOX, PRODUCTION}
  usage_date date
  request_count long
  error_count long
  rate_limit_count long
  p95_latency_ms long
  created_at date
  updated_at date
  // Unique: partner_id + environment + usage_date
}

WebhookEndpoint [icon: link, color: blue] {
  _id objectId pk
  partner_id objectId ref Partner
  environment enum {SANDBOX, PRODUCTION}
  url string
  signing_secret_hash string
  subscribed_events string[]
  status enum {PENDING_VERIFICATION, ACTIVE, DISABLED}
  verified_at date nullable
  created_at date
  updated_at date
  // Unique: partner_id + environment + url
}

// VENUE AND INVENTORY

Venue [icon: home, color: green] {
  _id objectId pk
  legal_name string
  display_name string
  environment enum {SANDBOX, PRODUCTION}
  timezone string
  address document
  geo point
  currency string
  media document[]
  status enum {DRAFT, PENDING_APPROVAL, ACTIVE, SUSPENDED}
  approved_by objectId ref AdminUser nullable
  approved_at date nullable
  audit_history document[]
  version int
  created_at date
  updated_at date
}

Court [icon: square, color: green] {
  _id objectId pk
  venue_id objectId ref Venue
  name string
  sport_types string[]
  booking_mode enum {OPEN_TIME, FIXED_SLOT, BOTH}
  min_booking_minutes int
  booking_increment_minutes int
  operating_hours document[]
  timezone string
  media document[]
  status enum {ACTIVE, INACTIVE}
  audit_history document[]
  version int
  created_at date
  updated_at date
  // Unique: venue_id + name
}

PricingRule [icon: dollar-sign, color: green] {
  _id objectId pk
  court_id objectId ref Court
  name string
  days_of_week int[]
  starts_time string
  ends_time string
  amount_minor long
  currency string
  effective_from date
  effective_to date nullable
  priority int
  status enum {ACTIVE, INACTIVE}
  created_at date
  updated_at date
}

Slot [icon: clock, color: green] {
  _id objectId pk
  court_id objectId ref Court
  environment enum {SANDBOX, PRODUCTION}
  booking_mode enum {OPEN_TIME, FIXED_SLOT}
  starts_at date
  ends_at date
  price_amount_minor long
  currency string
  status enum {AVAILABLE, HELD, BOOKED, BLOCKED, UNAVAILABLE}
  hold_id string nullable
  hold_partner_id objectId ref Partner nullable
  hold_expires_at date nullable
  hold_created_at date nullable
  generation_source string
  audit_history document[]
  version int
  created_at date
  updated_at date
  // Fixed-slot documents are reusable; open-time holds may be provisional
}

VenuePayoutAccount [icon: landmark, color: green] {
  _id objectId pk
  venue_id objectId ref Venue
  account_holder_name string
  vault_provider string
  vault_account_token string unique
  account_last4 string
  bank_name string
  ifsc_code string
  status enum {PENDING, VERIFIED, DISABLED}
  verified_by objectId ref AdminUser nullable
  verified_at date nullable
  verification_failure_reason string nullable
  created_at date
  updated_at date
}

VenueContent [icon: image, color: green] {
  _id objectId pk
  venue_id objectId ref Venue
  content document
  version int
  updated_by_type enum {ADMIN_USER, VENUE_OWNER}
  updated_by_id objectId
  created_at date
  updated_at date
  // Unique: venue_id
}

// CONTRACTS

PartnerVenueContract [icon: file-text, color: teal] {
  _id objectId pk
  partner_id objectId ref Partner
  venue_id objectId ref Venue
  version int
  status enum {DRAFT, ACTIVE, SUPERSEDED, TERMINATED}
  commission_bps int
  tax_bps int
  settlement_cycle document
  allowed_booking_modes string[]
  cancellation_terms document
  refund_rules document[]
  resale_cutoff_minutes int
  terms_version int
  effective_from date
  effective_to date nullable
  created_by objectId ref AdminUser
  created_at date
  // Unique: partner_id + venue_id + effective_from
}

// BOOKING

Booking [icon: calendar-check, color: yellow] {
  _id objectId pk
  partner_id objectId ref Partner
  venue_id objectId ref Venue
  court_id objectId ref Court
  slot_id objectId ref Slot nullable
  contract_id objectId ref PartnerVenueContract
  environment enum {SANDBOX, PRODUCTION}
  external_booking_reference string nullable
  confirm_idempotency_key string
  booking_mode enum {OPEN_TIME, FIXED_SLOT}
  starts_at date
  ends_at date
  status enum {CONFIRMED, CANCELLED, COMPLETED, NO_SHOW}
  gross_amount_minor long
  currency string
  contract_terms_snapshot document
  cancellation_terms_snapshot document
  audit_history document[]
  version int
  confirmed_at date
  created_at date
  updated_at date
  // Unique: contract_id + environment + confirm_idempotency_key
}

BookingCancellation [icon: x-circle, color: yellow] {
  _id objectId pk
  booking_id objectId ref Booking
  idempotency_key string
  cancelled_by_type enum {ADMIN_USER, VENUE_OWNER, PARTNER, SYSTEM}
  cancelled_by_id objectId nullable
  reason string
  refund_bps int
  refund_amount_minor long
  inventory_released boolean
  cancelled_at date
  created_at date
  // One cancellation per booking in v1
}

ApiIdempotencyRecord [icon: shield, color: yellow] {
  _id objectId pk
  partner_id objectId ref Partner
  environment enum {SANDBOX, PRODUCTION}
  operation string
  idempotency_key string
  request_hash string
  status enum {PROCESSING, COMPLETED, FAILED}
  response_status int nullable
  response_body document nullable
  resource_type string nullable
  resource_id objectId nullable
  locked_until date nullable
  expires_at date
  created_at date
  updated_at date
  // Unique: partner_id + environment + operation + idempotency_key
}

// LEDGER

LedgerEntry [icon: book-open, color: red] {
  _id objectId pk
  journal_id string
  booking_id objectId ref Booking
  partner_id objectId ref Partner
  venue_id objectId ref Venue
  contract_id objectId ref PartnerVenueContract
  environment enum {SANDBOX, PRODUCTION}
  entry_type enum {BOOKING, COMMISSION, TAX, REVERSAL}
  account_code string
  direction enum {DEBIT, CREDIT}
  amount_minor long
  currency string
  reverses_entry_id objectId ref LedgerEntry nullable
  settlement_id objectId ref Settlement nullable
  payout_id objectId ref Payout nullable
  posted_at date
  created_at date
  // Append-only; settlement_id and payout_id are conditional one-time links
}

// FINANCIAL CLOSE

Settlement [icon: layers, color: red] {
  _id objectId pk
  partner_id objectId ref Partner
  environment enum {SANDBOX, PRODUCTION}
  period_start date
  period_end date
  currency string
  expected_amount_minor long
  state enum {DRAFT, PENDING_FUNDS, RECONCILING, RECONCILED, COMPLETED}
  completed_by objectId ref AdminUser nullable
  completed_at date nullable
  created_at date
  updated_at date
  // Unique: partner_id + environment + period_start + period_end
}

Reconciliation [icon: refresh-cw, color: red] {
  _id objectId pk
  settlement_id objectId ref Settlement
  reported_amount_minor long
  bank_reference string nullable
  evidence_uri string nullable
  status enum {PENDING, MATCHED, MISMATCH, RESOLVED}
  reconciled_by objectId ref AdminUser nullable
  reconciled_at date nullable
  notes string nullable
  attempt_history document[]
  created_at date
  updated_at date
  // Partial unique: settlement_id + bank_reference where bank_reference exists
}

Payout [icon: send, color: red] {
  _id objectId pk
  settlement_id objectId ref Settlement
  venue_id objectId ref Venue
  payout_account_id objectId ref VenuePayoutAccount
  idempotency_key string unique
  amount_minor long
  currency string
  status enum {PENDING, PROCESSING, PAID, FAILED}
  provider_reference string nullable
  failure_reason string nullable
  initiated_at date
  paid_at date nullable
  created_at date
  updated_at date
  // Unique: settlement_id + venue_id
}

Invoice [icon: file-text, color: red] {
  _id objectId pk
  settlement_id objectId ref Settlement
  partner_id objectId ref Partner
  invoice_number string unique
  subtotal_minor long
  tax_minor long
  total_minor long
  currency string
  status enum {DRAFT, ISSUED, VOID}
  issued_at date nullable
  created_at date
  updated_at date
}

// SHARED COMMUNICATIONS

OutboxEvent [icon: radio, color: gray] {
  _id objectId pk
  aggregate_type string
  aggregate_id objectId
  partner_id objectId ref Partner nullable
  venue_id objectId ref Venue nullable
  environment enum {SANDBOX, PRODUCTION}
  event_type string
  event_version int
  correlation_id string
  webhook_endpoint_ids objectId[]
  payload document
  webhook_deliveries document[]
  status enum {PENDING, PROCESSING, PUBLISHED, FAILED}
  available_at date
  locked_by string nullable
  locked_until date nullable
  published_at date nullable
  created_at date
  updated_at date
  // Unique: aggregate_type + aggregate_id + event_type + correlation_id
}

// REFERENCES

AdminUser._id < VenueOwner.approved_by
AdminUser._id < KycVerification.reviewed_by
AdminUser._id < Partner.production_approved_by
AdminUser._id < Venue.approved_by
AdminUser._id < VenuePayoutAccount.verified_by
AdminUser._id < PartnerVenueContract.created_by
AdminUser._id < Settlement.completed_by
AdminUser._id < Reconciliation.reconciled_by

VenueOwner._id < VenueOwnerMembership.owner_id
Venue._id < VenueOwnerMembership.venue_id

KycVerification._id < KycDocument.kyc_verification_id

Partner._id < PartnerApiKey.partner_id
Partner._id < ApiUsageDaily.partner_id
Partner._id < WebhookEndpoint.partner_id
Partner._id < Slot.hold_partner_id
Partner._id < PartnerVenueContract.partner_id
Partner._id < Booking.partner_id
Partner._id < ApiIdempotencyRecord.partner_id
Partner._id < LedgerEntry.partner_id
Partner._id < Settlement.partner_id
Partner._id < Invoice.partner_id
Partner._id < OutboxEvent.partner_id

Venue._id < Court.venue_id
Venue._id < VenuePayoutAccount.venue_id
Venue._id < VenueContent.venue_id
Venue._id < PartnerVenueContract.venue_id
Venue._id < Booking.venue_id
Venue._id < LedgerEntry.venue_id
Venue._id < Payout.venue_id
Venue._id < OutboxEvent.venue_id

Court._id < PricingRule.court_id
Court._id < Slot.court_id
Court._id < Booking.court_id

Slot._id < Booking.slot_id

PartnerVenueContract._id < Booking.contract_id
PartnerVenueContract._id < LedgerEntry.contract_id

Booking._id < BookingCancellation.booking_id
Booking._id < LedgerEntry.booking_id
LedgerEntry._id < LedgerEntry.reverses_entry_id

Settlement._id < Reconciliation.settlement_id
Settlement._id < LedgerEntry.settlement_id
Settlement._id < Payout.settlement_id
Settlement._id < Invoice.settlement_id

Payout._id < LedgerEntry.payout_id
VenuePayoutAccount._id < Payout.payout_account_id
