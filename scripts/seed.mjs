/**
 * End-to-end seed for local development.
 *
 * Drives the real API exactly as the four frontends will, so it doubles as a working
 * specification of the onboarding sequence:
 *
 *   owner registers → KYC submitted → OPS preliminary review → ADMIN final review
 *   → agreement proposed → owner accepts → venue approved → courts/pricing/slots
 *   → partner applies → sandbox approved → API key issued → contract created
 *   → partner books over the signed API → owner records a walk-in
 *
 * Run with the API and worker up:  node scripts/seed.mjs
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const BASE = process.env.SEED_API_BASE ?? 'http://localhost:3000/api/v1';

const ADMIN = { email: 'admin@turfgang.com', password: 'TurfGang@Admin2026' };
const OPS = { email: 'ops@turfgang.com', password: 'TurfGang@Ops2026' };

// A unique suffix keeps re-runs from colliding on the unique email/legal-name indexes.
const RUN = Date.now().toString(36).slice(-5);

const OWNER = {
  legalName: 'Greenfield Sports LLP',
  email: `owner.${RUN}@turfgang.com`,
  phoneE164: '+919876543210',
  password: 'TurfOwner@2026Pass',
  venue: {
    legalName: 'Greenfield Sports LLP',
    displayName: 'Greenfield Turf Vijay Nagar',
    timezone: 'Asia/Kolkata',
    address: {
      line1: '12 Scheme No 54, Vijay Nagar',
      city: 'Indore',
      state: 'Madhya Pradesh',
      postalCode: '452010',
      country: 'IN',
    },
    // Indore — the launch city.
    latitude: 22.7533,
    longitude: 75.8937,
  },
};

const PARTNER = {
  legalName: `PlayApp Technologies ${RUN}`,
  displayName: 'PlayApp',
  email: `partner.${RUN}@turfgang.com`,
  phoneE164: '+919812345678',
  password: 'PartnerPortal@2026',
};

/** A 1×1 PNG. The backend sniffs magic bytes rather than trusting the declared MIME type. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const KYC_DOCS = [
  { type: 'GST_CERTIFICATE', details: { gstNumber: '23AABCU9603R1ZM', legalName: OWNER.legalName } },
  { type: 'PAN', details: { panNumber: 'AABCU9603R', nameOnPan: OWNER.legalName } },
  {
    type: 'PASSBOOK',
    details: {
      accountHolderName: OWNER.legalName,
      bankName: 'HDFC Bank',
      ifscCode: 'HDFC0001234',
      accountLast4: '4321',
    },
  },
  { type: 'AADHAAR', details: { holderName: 'Rohit Sharma', aadhaarLast4: '8765' } },
];

let step = 0;
const log = (message) => console.log(`  ${String(++step).padStart(2, '0')}. ${message}`);
const warn = (message) => console.log(`      ! ${message}`);

async function call(path, { method = 'GET', body, token, headers = {}, form } = {}) {
  const requestHeaders = { Accept: 'application/json', ...headers };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }

  const response = await fetch(`${BASE}${path}`, { method, headers: requestHeaders, body: payload });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const error = parsed?.error ?? {};
    throw new Error(`${method} ${path} → ${response.status} ${error.code ?? ''} ${error.message ?? text}`);
  }
  return parsed;
}

/** Mirrors src/shared/auth/partner-signature.ts — the nonce line exists only with X-Request-Id. */
function signedHeaders({ method, path, body, apiKey, signingSecret, idempotencyKey }) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const requestId = randomUUID();
  const raw = body === undefined ? '' : JSON.stringify(body);
  const bodyHash = createHash('sha256').update(raw).digest('hex');

  const canonical = [timestamp, method.toUpperCase(), path, bodyHash, requestId].join('\n');
  const signature = createHmac('sha256', signingSecret).update(canonical).digest('hex');

  const headers = {
    'X-Api-Key': apiKey,
    'X-Signature': signature,
    'X-Timestamp': timestamp,
    'X-Request-Id': requestId,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  return headers;
}

async function signedCall(path, { method = 'GET', body, apiKey, signingSecret, idempotencyKey } = {}) {
  return call(path, {
    method,
    body,
    headers: signedHeaders({ method, path: `/api/v1${path}`, body, apiKey, signingSecret, idempotencyKey }),
  });
}

function isoDay(offsetDays = 0) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

async function main() {
  console.log('\nSeeding Turf GDS\n');

  // --- Admins ---------------------------------------------------------------
  const adminSession = await call('/auth/admin/login', { method: 'POST', body: ADMIN });
  const adminToken = adminSession.accessToken;
  log(`admin signed in (${adminSession.admin.role})`);

  let opsToken = null;
  try {
    opsToken = (await call('/auth/admin/login', { method: 'POST', body: OPS })).accessToken;
    log('ops reviewer signed in');
  } catch {
    warn('ops admin missing — KYC preliminary review will be attempted as ADMIN');
  }

  // --- Venue owner ----------------------------------------------------------
  const registration = await call('/auth/venue-owners/register', { method: 'POST', body: OWNER });
  const { ownerId, venueId } = registration;
  log(`owner + venue registered (venue ${venueId} starts PENDING)`);

  const ownerLogin = await call('/auth/venue-owners/login', {
    method: 'POST',
    body: { email: OWNER.email, password: OWNER.password },
  });
  const ownerToken = ownerLogin.sessionToken;
  log('owner signed in');

  // --- KYC ------------------------------------------------------------------
  const verification = await call('/kyc/owner/verifications', {
    method: 'POST',
    token: ownerToken,
    body: { verificationType: 'BUSINESS' },
  });
  const verificationId = verification.verificationId ?? verification.id ?? verification._id;
  log(`KYC draft created (${verificationId})`);

  for (const doc of KYC_DOCS) {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), `${doc.type.toLowerCase()}.png`);

    const uploaded = await call(
      `/kyc/owner/verifications/${verificationId}/documents?documentType=${doc.type}`,
      { method: 'POST', token: ownerToken, form },
    );
    const documentId = uploaded.documentId ?? uploaded.id ?? uploaded._id;

    await call(`/kyc/owner/verifications/${verificationId}/documents/${documentId}/details`, {
      method: 'PATCH',
      token: ownerToken,
      body: { documentType: doc.type, details: doc.details },
    });
  }
  log(`uploaded ${KYC_DOCS.length} KYC documents with details`);

  await call(`/kyc/owner/verifications/${verificationId}/submit`, { method: 'POST', token: ownerToken });
  log('KYC submitted');

  // Two-person rule: the preliminary check and the final decision must be different people.
  await call(`/kyc/admin/verifications/${verificationId}/preliminary-review`, {
    method: 'POST',
    token: opsToken ?? adminToken,
    body: {
      status: 'APPROVED',
      checklist: {
        documentReadable: true,
        detailsMatch: true,
        gstChecked: true,
        panChecked: true,
        bankChecked: true,
        aadhaarMasked: true,
      },
    },
  });
  log('preliminary review approved (OPS)');

  await call(`/kyc/admin/verifications/${verificationId}/review`, {
    method: 'PATCH',
    token: adminToken,
    body: { status: 'VERIFIED' },
  });
  log('KYC verified (ADMIN)');

  // --- Agreement ------------------------------------------------------------
  let templateId = null;
  try {
    const template = await call('/admin/contract-templates', {
      method: 'POST',
      token: adminToken,
      body: {
        code: `STD-${RUN}`,
        title: 'Standard venue onboarding agreement',
        termsText:
          'The venue lists inventory on the Turf GDS. The platform distributes it to booking partners, ' +
          'collects commission, and settles the venue net of commission and tax on the agreed cycle.',
      },
    });
    templateId = template.templateId ?? template.id ?? template._id;
    log('contract template created');
  } catch (error) {
    warn(`template creation skipped: ${error.message}`);
  }

  await call(`/admin/onboarding/venues/${venueId}/agreement`, {
    method: 'POST',
    token: adminToken,
    body: {
      ownerId,
      ...(templateId ? { templateId } : { termsText: 'Standard onboarding terms.' }),
      title: 'Greenfield Turf onboarding agreement',
      platformCommissionBps: 1200,
      settlementCycle: 'T_PLUS_N',
      settlementLagDays: 2,
      cancellationPolicy: {
        cancellationAllowed: true,
        defaultRefundBps: 5000,
        noShowRefundBps: 0,
        ownerCancellationNoticeMinutes: 720,
        refundRules: [
          { minMinutesBeforeStart: 1440, refundBps: 10000 },
          { minMinutesBeforeStart: 720, refundBps: 7500 },
          { minMinutesBeforeStart: 180, refundBps: 5000 },
        ],
      },
    },
  });
  log('agreement proposed (12% commission, T+2)');

  const agreement = await call(`/owner/venues/${venueId}/onboarding-agreement`, { token: ownerToken });
  const agreementVersion = agreement.version ?? agreement.agreement?.version ?? 1;
  await call(`/owner/venues/${venueId}/onboarding-agreement/accept`, {
    method: 'POST',
    token: ownerToken,
    body: { version: agreementVersion },
  });
  log('owner accepted the agreement');

  // --- Approval -------------------------------------------------------------
  await call(`/admin/onboarding/venues/${venueId}/approve`, {
    method: 'POST',
    token: adminToken,
    body: { ownerId },
  });
  log('venue APPROVED — now live');

  // --- Courts, pricing, inventory ------------------------------------------
  const courtSpecs = [
    { name: 'Court A — 7-a-side', sportType: 'FOOTBALL', surfaceType: 'Artificial grass', capacity: 14, price: 120000 },
    { name: 'Court B — 5-a-side', sportType: 'FOOTBALL', surfaceType: 'Artificial grass', capacity: 10, price: 90000 },
    { name: 'Court C — Box cricket', sportType: 'CRICKET', surfaceType: 'Matting', capacity: 12, price: 100000 },
  ];

  const courts = [];
  for (const spec of courtSpecs) {
    const court = await call(`/owner/venues/${venueId}/courts`, {
      method: 'POST',
      token: ownerToken,
      body: {
        name: spec.name,
        sportType: spec.sportType,
        surfaceType: spec.surfaceType,
        capacity: spec.capacity,
        bookingMode: 'BOTH',
        minBookingMinutes: 60,
        bookingIncrementMinutes: 30,
        fixedSlotDurationMinutes: 60,
        fixedSlotAnchorMinutes: 0,
      },
    });
    const courtId = court.courtId ?? court.id ?? court._id;
    courts.push({ courtId, ...spec });

    const current = await call(`/owner/venues/${venueId}/courts/${courtId}`, { token: ownerToken });
    await call(`/owner/venues/${venueId}/courts/${courtId}/operating-hours`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        version: current.version ?? current.court?.version ?? 1,
        operatingHours: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
          dayOfWeek,
          opensAt: '06:00',
          closesAt: '23:00',
        })),
      },
    });

    await call(`/owner/venues/${venueId}/courts/${courtId}/pricing-rules`, {
      method: 'POST',
      token: ownerToken,
      body: {
        name: 'Standard rate',
        priceMinor: spec.price,
        currency: 'INR',
        effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
        priority: 10,
      },
    });

    await call(`/owner/venues/${venueId}/courts/${courtId}/slots/generate`, {
      method: 'POST',
      token: ownerToken,
      body: { dateFrom: isoDay(0), dateTo: isoDay(13) },
    });
  }
  log(`${courts.length} courts created with hours, pricing and 14 days of slots`);

  // --- Partner --------------------------------------------------------------
  const application = await call('/partners/applications', { method: 'POST', body: PARTNER });
  const partnerId = application.partnerId ?? application.id ?? application._id;
  log(`partner applied (${partnerId})`);

  await call(`/partners/admin/${partnerId}/approve-sandbox`, { method: 'POST', token: adminToken });
  log('sandbox approved');

  // A contract requires an ACTIVE partner, and a partner only becomes ACTIVE once production is
  // approved — which itself requires verified BUSINESS KYC. So the whole partner pipeline runs here.
  const partnerLogin = await call('/partners/auth/login', {
    method: 'POST',
    body: { email: PARTNER.email, password: PARTNER.password },
  });
  const partnerToken = partnerLogin.sessionToken;

  const partnerVerification = await call('/kyc/partner/verifications', {
    method: 'POST',
    token: partnerToken,
    body: { verificationType: 'BUSINESS' },
  });
  const partnerVerificationId =
    partnerVerification.verificationId ?? partnerVerification.id ?? partnerVerification._id;

  const partnerDocs = [
    { type: 'GST_CERTIFICATE', details: { gstNumber: '27AACCP1234M1Z5', legalName: PARTNER.legalName } },
    { type: 'PAN', details: { panNumber: 'AACCP1234M', nameOnPan: PARTNER.legalName } },
    {
      type: 'PASSBOOK',
      details: {
        accountHolderName: PARTNER.legalName,
        bankName: 'ICICI Bank',
        ifscCode: 'ICIC0000123',
        accountLast4: '9988',
      },
    },
    { type: 'AADHAAR', details: { holderName: 'Priya Nair', aadhaarLast4: '2244' } },
  ];

  for (const doc of partnerDocs) {
    const form = new FormData();
    form.append('file', new Blob([PNG], { type: 'image/png' }), `${doc.type.toLowerCase()}.png`);
    const uploaded = await call(
      `/kyc/partner/verifications/${partnerVerificationId}/documents?documentType=${doc.type}`,
      { method: 'POST', token: partnerToken, form },
    );
    const documentId = uploaded.documentId ?? uploaded.id ?? uploaded._id;
    await call(`/kyc/partner/verifications/${partnerVerificationId}/documents/${documentId}/details`, {
      method: 'PATCH',
      token: partnerToken,
      body: { documentType: doc.type, details: doc.details },
    });
  }
  await call(`/kyc/partner/verifications/${partnerVerificationId}/submit`, {
    method: 'POST',
    token: partnerToken,
  });

  await call(`/kyc/admin/verifications/${partnerVerificationId}/preliminary-review`, {
    method: 'POST',
    token: opsToken ?? adminToken,
    body: {
      status: 'APPROVED',
      checklist: {
        documentReadable: true,
        detailsMatch: true,
        gstChecked: true,
        panChecked: true,
        bankChecked: true,
        aadhaarMasked: true,
      },
    },
  });
  await call(`/kyc/admin/verifications/${partnerVerificationId}/review`, {
    method: 'PATCH',
    token: adminToken,
    body: { status: 'VERIFIED' },
  });
  log('partner KYC verified');

  await call(`/partners/admin/${partnerId}/integration-review`, {
    method: 'PATCH',
    token: adminToken,
    body: { status: 'PASSED' },
  });
  await call(`/partners/admin/${partnerId}/approve-production`, { method: 'POST', token: adminToken });
  log('partner approved for production — now ACTIVE');

  const SCOPES = ['availability:read', 'bookings:write', 'reports:read', 'finance:read', 'webhooks:write'];

  const sandboxKey = await call(`/partners/admin/${partnerId}/keys`, {
    method: 'POST',
    token: adminToken,
    body: { environment: 'SANDBOX', scopes: SCOPES },
  });

  // Owner self-registration creates venues in PRODUCTION, and environment isolation means a
  // SANDBOX key can never see them — so the booking demo below needs a production credential.
  const key = await call(`/partners/admin/${partnerId}/keys`, {
    method: 'POST',
    token: adminToken,
    body: { environment: 'PRODUCTION', scopes: SCOPES },
  });
  log('sandbox + production API keys issued');

  // --- Contract -------------------------------------------------------------
  let contractCreated = false;
  try {
    await call('/admin/contracts', {
      method: 'POST',
      token: adminToken,
      body: {
        partnerId,
        venueId,
        commissionRateBps: 1200,
        taxRateBps: 1800,
        settlementCycle: 'T_PLUS_N',
        settlementLagDays: 2,
        // Singular enum, not an array — BOTH covers fixed-slot and open-time bookings.
        allowedBookingModes: 'BOTH',
        effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
        // Must mirror the policy the owner already accepted, or the write is rejected.
        cancellationTerms: {
          cancellationAllowed: true,
          defaultRefundBps: 5000,
          releaseInventory: true,
        },
        refundRules: [
          { minMinutesBeforeStart: 1440, refundBps: 10000, releaseInventory: true },
          { minMinutesBeforeStart: 720, refundBps: 7500, releaseInventory: true },
          { minMinutesBeforeStart: 180, refundBps: 5000, releaseInventory: true },
        ],
        resaleCutoffMinutes: 120,
      },
    });
    contractCreated = true;
    log('partner ↔ venue contract created');
  } catch (error) {
    warn(`contract creation failed: ${error.message}`);
    warn('partner bookings will be skipped — availability requires an in-effect contract');
  }

  // --- Partner bookings over the signed API --------------------------------
  let bookingsMade = 0;
  if (contractCreated) {
    try {
      // The availability window is capped at 24 hours. Derive both ends from one timestamp —
      // calling Date.now() twice pushes the range a few milliseconds over the limit.
      const base = Date.now() + 86_400_000;
      const from = new Date(base);
      const to = new Date(base + 12 * 3_600_000);
      const availability = await signedCall(
        `/venues/${venueId}/availability?startsAt=${encodeURIComponent(from.toISOString())}` +
          `&endsAt=${encodeURIComponent(to.toISOString())}&limit=20`,
        { apiKey: key.apiKey, signingSecret: key.signingSecret },
      );

      // Availability items expose `availabilityId` — that is the value `/bookings/hold` wants as
      // `slotId`. Only bookable intervals are returned, so there is no status to filter on.
      const slots = (availability.items ?? []).filter((item) => item.availabilityId);
      log(`partner sees ${slots.length} bookable slots tomorrow`);

      for (const slot of slots.slice(0, 4)) {
        const hold = await signedCall('/bookings/hold', {
          method: 'POST',
          apiKey: key.apiKey,
          signingSecret: key.signingSecret,
          body: { bookingType: 'FIXED_SLOT', slotId: slot.availabilityId },
        });

        await signedCall('/bookings/confirm', {
          method: 'POST',
          apiKey: key.apiKey,
          signingSecret: key.signingSecret,
          idempotencyKey: randomUUID(),
          body: {
            holdId: hold.holdId ?? hold.hold?.id,
            externalBookingReference: `PLAYAPP-${randomUUID().slice(0, 8)}`,
            customerReference: ['Aarav M.', 'Sneha K.', 'Vikram R.', 'Imran S.'][bookingsMade % 4],
          },
        });
        bookingsMade += 1;
      }
      log(`${bookingsMade} online bookings confirmed through the partner API`);
    } catch (error) {
      warn(`partner booking flow stopped: ${error.message}`);
    }
  }

  // --- Sandbox mirror -------------------------------------------------------
  // Owner self-registration only ever produces PRODUCTION venues, so without this the developer
  // console's sandbox mode would return empty results for every query. Admin venue creation
  // takes an explicit environment and attaches the owner membership in the same transaction.
  let sandboxVenueId = null;
  try {
    const sandboxVenue = await call('/admin/venues', {
      method: 'POST',
      token: adminToken,
      body: {
        ownerId,
        environment: 'SANDBOX',
        legalName: OWNER.venue.legalName,
        displayName: `${OWNER.venue.displayName} (Sandbox)`,
        timezone: OWNER.venue.timezone,
        address: OWNER.venue.address,
        latitude: OWNER.venue.latitude,
        longitude: OWNER.venue.longitude,
      },
    });
    sandboxVenueId = sandboxVenue.venueId ?? sandboxVenue.id ?? sandboxVenue._id;

    // Agreements are per-venue, so the sandbox venue needs its own proposal and acceptance
    // before it can be approved — KYC being verified for the owner is not sufficient.
    await call(`/admin/onboarding/venues/${sandboxVenueId}/agreement`, {
      method: 'POST',
      token: adminToken,
      body: {
        ownerId,
        ...(templateId ? { templateId } : { termsText: 'Standard onboarding terms.' }),
        title: 'Greenfield Turf sandbox onboarding agreement',
        platformCommissionBps: 1200,
        settlementCycle: 'T_PLUS_N',
        settlementLagDays: 2,
        cancellationPolicy: {
          cancellationAllowed: true,
          defaultRefundBps: 5000,
          noShowRefundBps: 0,
          ownerCancellationNoticeMinutes: 720,
          refundRules: [{ minMinutesBeforeStart: 1440, refundBps: 10000 }],
        },
      },
    });

    const sandboxAgreement = await call(`/owner/venues/${sandboxVenueId}/onboarding-agreement`, {
      token: ownerToken,
    });
    await call(`/owner/venues/${sandboxVenueId}/onboarding-agreement/accept`, {
      method: 'POST',
      token: ownerToken,
      body: { version: sandboxAgreement.version ?? sandboxAgreement.agreement?.version ?? 1 },
    });

    await call(`/admin/onboarding/venues/${sandboxVenueId}/approve`, {
      method: 'POST',
      token: adminToken,
      body: { ownerId },
    });

    const sandboxCourt = await call(`/owner/venues/${sandboxVenueId}/courts`, {
      method: 'POST',
      token: ownerToken,
      body: {
        name: 'Sandbox Court 1',
        sportType: 'FOOTBALL',
        surfaceType: 'Artificial grass',
        capacity: 12,
        bookingMode: 'BOTH',
        minBookingMinutes: 60,
        bookingIncrementMinutes: 30,
        fixedSlotDurationMinutes: 60,
        fixedSlotAnchorMinutes: 0,
      },
    });
    const sandboxCourtId = sandboxCourt.courtId ?? sandboxCourt.id ?? sandboxCourt._id;

    const readBack = await call(`/owner/venues/${sandboxVenueId}/courts/${sandboxCourtId}`, {
      token: ownerToken,
    });
    await call(`/owner/venues/${sandboxVenueId}/courts/${sandboxCourtId}/operating-hours`, {
      method: 'PUT',
      token: ownerToken,
      body: {
        version: readBack.version ?? 1,
        operatingHours: [1, 2, 3, 4, 5, 6, 7].map((dayOfWeek) => ({
          dayOfWeek,
          opensAt: '06:00',
          closesAt: '23:00',
        })),
      },
    });
    await call(`/owner/venues/${sandboxVenueId}/courts/${sandboxCourtId}/pricing-rules`, {
      method: 'POST',
      token: ownerToken,
      body: {
        name: 'Sandbox rate',
        priceMinor: 100000,
        currency: 'INR',
        effectiveFrom: new Date(Date.now() - 86_400_000).toISOString(),
        priority: 10,
      },
    });
    await call(`/owner/venues/${sandboxVenueId}/courts/${sandboxCourtId}/slots/generate`, {
      method: 'POST',
      token: ownerToken,
      body: { dateFrom: isoDay(0), dateTo: isoDay(13) },
    });

    await call('/admin/contracts', {
      method: 'POST',
      token: adminToken,
      body: {
        partnerId,
        venueId: sandboxVenueId,
        commissionRateBps: 1200,
        taxRateBps: 1800,
        settlementCycle: 'T_PLUS_N',
        settlementLagDays: 2,
        allowedBookingModes: 'BOTH',
        effectiveFrom: new Date(Date.now() - 3_600_000).toISOString(),
        cancellationTerms: { cancellationAllowed: true, defaultRefundBps: 5000, releaseInventory: true },
        refundRules: [{ minMinutesBeforeStart: 1440, refundBps: 10000, releaseInventory: true }],
        resaleCutoffMinutes: 120,
      },
    });
    log('sandbox venue mirrored — the developer console sandbox now returns real data');
  } catch (error) {
    warn(`sandbox mirror skipped: ${error.message}`);
  }

  // --- Owner walk-in --------------------------------------------------------
  try {
    const start = new Date();
    start.setHours(start.getHours() + 3, 0, 0, 0);
    const end = new Date(start.getTime() + 3_600_000);

    const direct = await call(`/owner/venues/${venueId}/bookings`, {
      method: 'POST',
      token: ownerToken,
      body: {
        courtId: courts[0].courtId,
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        customerName: 'Walk-in — Rahul',
        customerPhone: '+919812311111',
        reasonNote: 'Paid at the counter',
      },
    });
    const bookingId = direct.bookingId ?? direct.id ?? direct._id;

    await call(`/owner/venues/${venueId}/bookings/${bookingId}/payment`, {
      method: 'POST',
      token: ownerToken,
      body: { amountMinor: courts[0].price, method: 'UPI', reference: `UPI-${RUN}`, notes: 'Counter payment' },
    });
    log('walk-in booking recorded with a UPI payment');
  } catch (error) {
    warn(`walk-in booking skipped: ${error.message}`);
  }

  // --- Summary --------------------------------------------------------------
  // The owner and partner emails carry a per-run suffix, so they change every seed. Writing them
  // to a file means there is always one place to look instead of scrolling back through output.
  const summary = `# Local credentials

Written by \`node scripts/seed.mjs\` on ${new Date().toISOString()}.
Every seed run creates a NEW owner and partner, and rewrites this file.

## Sign in

| App | URL | Email | Password |
|---|---|---|---|
| Admin portal | http://localhost:5180 | ${ADMIN.email} | ${ADMIN.password} |
| Admin portal (OPS) | http://localhost:5180 | ${OPS.email} | ${OPS.password} |
| Owner web app | http://localhost:5181 | ${OWNER.email} | ${OWNER.password} |
| Partner console | http://localhost:5182 | ${PARTNER.email} | ${PARTNER.password} |

The mobile app uses the same owner login as the owner web app.

Both admins are needed to demo KYC: the preliminary check and the final decision must be made by
two different people, so one account cannot complete a verification on its own.

## Ids

    venueId (production)  ${venueId}
    venueId (sandbox)     ${sandboxVenueId ?? 'not created'}
    ownerId               ${ownerId}
    partnerId             ${partnerId}

## Partner API keys

The API returns these once and cannot show them again — re-run the seed for a new pair.

    Sandbox key        ${sandboxKey.apiKey}
    Sandbox secret     ${sandboxKey.signingSecret}
    Production key     ${key.apiKey}
    Production secret  ${key.signingSecret}

Sandbox keys only see the sandbox venue and production keys only see the production one —
environment isolation is absolute, so a mismatched pair returns an empty result or a 404.
`;

  writeFileSync(new URL('../CREDENTIALS.md', import.meta.url), summary);

  console.log(`
Done.

  Admin portal      http://localhost:5180   ${ADMIN.email} / ${ADMIN.password}
  Admin (OPS)       http://localhost:5180   ${OPS.email} / ${OPS.password}
  Owner web app     http://localhost:5181   ${OWNER.email} / ${OWNER.password}
  Partner console   http://localhost:5182   ${PARTNER.email} / ${PARTNER.password}

  venueId (production)  ${venueId}
  venueId (sandbox)     ${sandboxVenueId ?? 'not created'}
  ownerId               ${ownerId}
  partnerId             ${partnerId}

  Sandbox key        ${sandboxKey.apiKey}
  Sandbox secret     ${sandboxKey.signingSecret}
  Production key     ${key.apiKey}
  Production secret  ${key.signingSecret}
  (the API returns these once and cannot show them again)

  All of the above is also saved to CREDENTIALS.md
`);
}

main().catch((error) => {
  console.error(`\nSeed failed: ${error.message}\n`);
  process.exitCode = 1;
});
