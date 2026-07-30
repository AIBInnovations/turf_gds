# Venue module subdomains

The Venue module is organized by business ownership rather than actor or
transport:

- `profile/` owns the Venue aggregate, onboarding/approval capability, owner
  profile management, media metadata, and Venue persistence bootstrap.
- `courts/` owns Court configuration, operating hours, Court media, and
  owner-facing Court routes.
- `inventory/` owns pricing rules, Slots, fixed/open-time availability
  controls, availability search, and their persistence indexes.
- `payout-accounts/` owns tokenized Venue payout-account persistence,
  owner add/list operations, and Admin verification.

Cross-subdomain dependencies point inward through exported service/repository
interfaces. HTTP paths are unchanged by this layout.
