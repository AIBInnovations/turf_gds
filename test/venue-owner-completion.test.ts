import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ObjectId } from 'mongodb';

import { createSimplePdf } from '../src/shared/documents/simple-pdf.js';
import { externalEventType } from '../src/shared/communications/communications.types.js';
import { createVenueContentService } from '../src/modules/venue/content/venue-content.service.js';
import type { VenueContentDocument } from '../src/modules/venue/content/venue-content.types.js';
import type { VenueContentRepository } from '../src/modules/venue/content/venue-content.repository.js';
import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import { createAdminOnboardingService } from '../src/modules/admin/onboarding/onboarding.service.js';
import { AppError } from '../src/shared/errors/app-error.js';

test('generated settlement documents are downloadable PDF files', () => {
  const pdf = createSimplePdf('Venue Settlement Statement', [
    'Settlement ID: 687f00000000000000000001',
    'Venue net: 125000 INR',
  ]);
  assert.equal(pdf.subarray(0, 8).toString('ascii'), '%PDF-1.4');
  assert.match(pdf.toString('ascii'), /Venue Settlement Statement/);
  assert.match(pdf.toString('ascii'), /%%EOF$/);
});

test('expanded notification events have stable public event names', () => {
  assert.equal(externalEventType('PAYMENT_RECORDED'), 'payment.recorded');
  assert.equal(externalEventType('CONTRACT_ACCEPTED'), 'contract.accepted');
  assert.equal(externalEventType('KYC_REJECTED'), 'kyc.rejected');
  assert.equal(externalEventType('AVAILABILITY_CHANGED'), 'inventory.changed');
});

test('flexible Venue content creates and versions arbitrary approved sections', async () => {
  const ownerId = new ObjectId();
  const venueId = new ObjectId();
  let stored: VenueContentDocument | null = null;
  const repository: VenueContentRepository = {
    async find() { return stored; },
    async save({ document, expectedVersion }) {
      if (expectedVersion === null) stored = document;
      else if (stored?.version === expectedVersion) stored = { ...stored, content: document.content, version: stored.version + 1, updated_at: document.updated_at };
      else return null;
      return stored;
    },
  };
  const permissions: string[] = [];
  const events: string[] = [];
  const ownerAccessService = {
    async requirePermission(_owner: string, _venue: string, permission: string) { permissions.push(permission); },
  } as unknown as OwnerAccessService;
  const service = createVenueContentService({
    repository,
    ownerAccessService,
    events: { async publish(value) { events.push(value.eventType); } },
    now: () => new Date('2026-08-01T00:00:00.000Z'),
  });
  const created = await service.put({ actorOwnerId: ownerId.toHexString(), venueId: venueId.toHexString(), locale: 'en-IN', version: 0, content: { amenities: ['Parking'], faq: [{ question: 'Shoes?', answer: 'Studs allowed' }] }, correlationId: 'content-create' }) as Record<string, unknown>;
  const updated = await service.put({ actorOwnerId: ownerId.toHexString(), venueId: venueId.toHexString(), locale: 'en-IN', version: 1, content: { amenities: ['Parking', 'Showers'], house_rules: ['No smoking'] }, correlationId: 'content-update' }) as Record<string, unknown>;
  assert.equal(created.version, 1);
  assert.equal(updated.version, 2);
  assert.deepEqual(permissions, ['MANAGE_VENUE', 'MANAGE_VENUE']);
  assert.deepEqual(events, ['VENUE_UPDATED', 'VENUE_UPDATED']);
});

test('production onboarding rejects activation until contract terms are accepted', async () => {
  let identityApproved = false;
  const service = createAdminOnboardingService({
    identityService: { async approveVenueOwner() { identityApproved = true; } } as never,
    kycService: { async isVerified() { return true; } } as never,
    venueService: { async approveVenue() {} } as never,
    agreementService: { async isAccepted() { return false; } } as never,
    database: { async withTransaction(work: (value: { session: never }) => Promise<void>) { await work({ session: undefined as never }); } } as never,
  });
  await assert.rejects(
    service.approveVenueOnboarding({ ownerId: new ObjectId().toHexString(), venueId: new ObjectId().toHexString(), adminId: new ObjectId().toHexString(), correlationId: 'approve' }),
    (error: unknown) => error instanceof AppError && error.code === 'ONBOARDING_AGREEMENT_REQUIRED',
  );
  assert.equal(identityApproved, false);
});
