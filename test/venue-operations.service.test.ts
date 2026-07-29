import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId, type ClientSession, type Db } from 'mongodb';

import type { OwnerAccessService } from '../src/modules/identity/owner/owner-access.service.js';
import type { CourtRepository } from '../src/modules/venue/court.repository.js';
import type { CourtDocument } from '../src/modules/venue/court.types.js';
import type {
  PricingRuleDocument,
  SlotDocument,
  VenuePayoutAccountDocument,
} from '../src/modules/venue/inventory.types.js';
import type { VenueOperationsRepository } from '../src/modules/venue/venue-operations.repository.js';
import { createVenueOperationsService } from '../src/modules/venue/venue-operations.service.js';
import type { VenueRepository } from '../src/modules/venue/venue.repository.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';
import type { DatabaseConnection } from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

const ownerId = new ObjectId('687f00000000000000000100');
const venueId = new ObjectId('687f00000000000000000101');
const courtId = new ObjectId('687f00000000000000000102');
const fixedNow = new Date('2026-07-28T00:00:00.000Z');

function createFixture() {
  const pricing: PricingRuleDocument[] = [];
  const slots: SlotDocument[] = [];
  const payouts: VenuePayoutAccountDocument[] = [];
  let courtVersion = 3;

  const venue: VenueDocument = {
    _id: venueId,
    legal_name: 'Venue Operations Private Limited',
    display_name: 'Venue Operations',
    environment: 'PRODUCTION',
    timezone: 'Asia/Kolkata',
    address: {
      line1: 'MG Road',
      city: 'Bengaluru',
      state: 'Karnataka',
      postal_code: '560001',
      country: 'IN',
    },
    geo: { type: 'Point', coordinates: [77.59, 12.97] },
    currency: 'INR',
    media: [],
    status: 'ACTIVE',
    audit_history: [],
    version: 1,
    created_at: fixedNow,
    updated_at: fixedNow,
  };
  const court: CourtDocument = {
    _id: courtId,
    venue_id: venueId,
    name: 'Court One',
    sport_type: 'FOOTBALL',
    surface_type: 'ARTIFICIAL_TURF',
    capacity: 10,
    booking_mode: 'BOTH',
    min_booking_minutes: 60,
    booking_increment_minutes: 30,
    operating_hours: { entries: [
      { day_of_week: 2, opens_at: '06:00', closes_at: '08:00' },
    ] },
    fixed_slot_duration_minutes: null,
    fixed_slot_anchor_minutes: null,
    media: [],
    status: 'AVAILABLE',
    audit_history: [],
    version: courtVersion,
    created_at: fixedNow,
    updated_at: fixedNow,
  };

  const repository: VenueOperationsRepository = {
    async insertPricingRule(value) {
      pricing.push(value);
    },
    async listPricingRules(id) {
      return pricing.filter((value) => value.court_id.equals(id));
    },
    async findPricingRule(id, requestedCourtId) {
      return pricing.find(
        (value) =>
          value._id.equals(id) && value.court_id.equals(requestedCourtId),
      ) ?? null;
    },
    async updatePricingRule(id, requestedCourtId, changes) {
      const value = pricing.find(
        (candidate) =>
          candidate._id.equals(id) &&
          candidate.court_id.equals(requestedCourtId),
      );
      if (!value) return null;
      Object.assign(value, changes);
      return value;
    },
    async bulkUpsertSlots(values) {
      let created = 0;
      for (const value of values) {
        const duplicate = slots.some(
          (candidate) =>
            candidate.court_id.equals(value.court_id) &&
            candidate.environment === value.environment &&
            candidate.booking_type === value.booking_type &&
            candidate.starts_at.getTime() === value.starts_at.getTime() &&
            candidate.ends_at.getTime() === value.ends_at.getTime(),
        );
        if (!duplicate) {
          slots.push(value);
          created += 1;
        }
      }
      return created;
    },
    async listSlots(id, from, to) {
      return slots.filter(
        (value) =>
          value.court_id.equals(id) &&
          value.starts_at < to &&
          value.ends_at > from,
      );
    },
    async updateFixedSlot(input) {
      const slot = slots.find(
        (value) =>
          value._id.equals(input.slotId) &&
          value.court_id.equals(input.courtId) &&
          value.booking_type === 'FIXED_SLOT' &&
          value.status === input.fromStatus &&
          value.version === input.expectedVersion,
      );
      if (!slot) return null;
      slot.status = input.toStatus;
      slot.version += 1;
      slot.updated_at = input.now;
      return slot;
    },
    async findOverlap(id, environment, startsAt, endsAt) {
      return slots.find(
        (value) =>
          value.court_id.equals(id) &&
          value.environment === environment &&
          ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'].includes(
            value.status,
          ) &&
          value.starts_at < endsAt &&
          value.ends_at > startsAt,
      ) ?? null;
    },
    async lockCourtForInventory(input) {
      if (input.expectedVersion !== courtVersion) return false;
      courtVersion += 1;
      court.version = courtVersion;
      return true;
    },
    async insertOpenBlock(value) {
      slots.push(value);
    },
    async deleteOpenBlock(input) {
      const index = slots.findIndex(
        (value) =>
          value._id.equals(input.slotId) &&
          value.court_id.equals(input.courtId) &&
          value.booking_type === 'OPEN_TIME' &&
          value.status === 'BLOCKED' &&
          value.version === input.expectedVersion,
      );
      if (index < 0) return false;
      slots.splice(index, 1);
      return true;
    },
    async findSlot(id, requestedCourtId) {
      return slots.find(
        (value) =>
          value._id.equals(id) && value.court_id.equals(requestedCourtId),
      ) ?? null;
    },
    async insertPayoutAccount(value) {
      if (
        payouts.some(
          (candidate) =>
            candidate.vault_account_token === value.vault_account_token,
        )
      ) {
        throw { code: 11_000 };
      }
      payouts.push(value);
    },
    async listPayoutAccounts(id) {
      return payouts.filter((value) => value.venue_id.equals(id));
    },
  };

  const ownerAccessService: OwnerAccessService = {
    async authenticateOwner() {
      return {
        actorType: 'OWNER',
        ownerId: ownerId.toHexString(),
        status: 'ACTIVE',
      };
    },
    async logout() {},
    async getProfile() {
      throw new Error('not used');
    },
    async requirePermission(actorOwnerId, requestedVenueId) {
      if (
        actorOwnerId !== ownerId.toHexString() ||
        requestedVenueId !== venueId.toHexString()
      ) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Denied',
          statusCode: 403,
        });
      }
    },
    async requireVenueMembership(actorOwnerId, requestedVenueId) {
      if (
        actorOwnerId !== ownerId.toHexString() ||
        requestedVenueId !== venueId.toHexString()
      ) {
        throw new AppError({
          code: 'PERMISSION_DENIED',
          message: 'Denied',
          statusCode: 403,
        });
      }
      return { membershipId: new ObjectId().toHexString(), role: 'OWNER' };
    },
    async listMembers() {
      return [];
    },
    async addMember() {
      throw new Error('not used');
    },
    async revokeMember() {},
  };
  const courtRepository: CourtRepository = {
    async insert() {},
    async findByIdAndVenue(id, requestedVenueId) {
      return id.equals(courtId) && requestedVenueId.equals(venueId)
        ? court
        : null;
    },
    async listByVenue() {
      return [court];
    },
    async update() {
      return null;
    },
    async appendMedia() {
      return null;
    },
  };
  const venueRepository: VenueRepository = {
    async insertInitialVenue() {},
    async approveVenue() {
      return true;
    },
    async findById(id) {
      return id.equals(venueId) ? venue : null;
    },
    async updateProfile() {
      return null;
    },
    async appendMedia() {
      return null;
    },
  };
  const database: DatabaseConnection = {
    db: {} as Db,
    async connect() {},
    async ping() {},
    async close() {},
    async withTransaction(operation) {
      return operation({
        db: {} as Db,
        session: {} as ClientSession,
      });
    },
  };

  return {
    service: createVenueOperationsService({
      repository,
      venueRepository,
      courtRepository,
      ownerAccessService,
      database,
      now: () => fixedNow,
    }),
    slots,
    payouts,
    getCourtVersion: () => courtVersion,
  };
}

test('pricing rules drive idempotent fixed-slot generation', async () => {
  const fixture = createFixture();
  const common = {
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    dayOfWeek: 2,
    startTime: '06:00',
    endTime: '08:00',
    currency: 'INR',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
  };
  await fixture.service.createPricingRule({
    ...common,
    name: 'Standard',
    priceMinor: 1000,
    priority: 1,
  });
  await fixture.service.createPricingRule({
    ...common,
    name: 'Peak override',
    priceMinor: 1500,
    priority: 10,
  });

  const first = await fixture.service.generateFixedSlots({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    dateFrom: '2026-07-28',
    dateTo: '2026-07-28',
    correlationId: 'generation-1',
  });
  const second = await fixture.service.generateFixedSlots({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    dateFrom: '2026-07-28',
    dateTo: '2026-07-28',
    correlationId: 'generation-2',
  });

  assert.equal(first.created, 2);
  assert.equal(second.created, 0);
  assert.deepEqual(
    fixture.slots.map((slot) => slot.price_minor),
    [1500, 1500],
  );
});

test('fixed inventory can only move AVAILABLE to BLOCKED and back by version', async () => {
  const fixture = createFixture();
  await fixture.service.createPricingRule({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    name: 'Standard',
    dayOfWeek: 2,
    startTime: '06:00',
    endTime: '08:00',
    priceMinor: 1000,
    currency: 'INR',
    effectiveFrom: '2026-07-01T00:00:00.000Z',
    priority: 1,
  });
  await fixture.service.generateFixedSlots({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    dateFrom: '2026-07-28',
    dateTo: '2026-07-28',
    correlationId: 'generation',
  });
  const slot = fixture.slots[0]!;
  const blocked = await fixture.service.blockAvailability({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    correlationId: 'block',
    reason: 'Maintenance',
    slotId: slot._id.toHexString(),
    slotVersion: 1,
  }) as { status: string; version: number };

  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.version, 2);
  await assert.rejects(
    fixture.service.blockAvailability({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      correlationId: 'stale',
      reason: 'Again',
      slotId: slot._id.toHexString(),
      slotVersion: 1,
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'SLOT_BLOCK_CONFLICT',
  );

  const released = await fixture.service.releaseAvailability({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    slotId: slot._id.toHexString(),
    expectedVersion: 2,
    reason: 'Maintenance complete',
    correlationId: 'release',
  }) as { status: string };
  assert.equal(released.status, 'AVAILABLE');
});

test('open-time blocks use the Court version mutex and reject overlap', async () => {
  const fixture = createFixture();
  const blocked = await fixture.service.blockAvailability({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    correlationId: 'open-block',
    reason: 'Private event',
    courtVersion: fixture.getCourtVersion(),
    startsAt: '2026-07-28T01:30:00.000Z',
    endsAt: '2026-07-28T02:30:00.000Z',
  }) as { id: string; version: number };

  assert.equal(fixture.slots[0]?.status, 'BLOCKED');
  await assert.rejects(
    fixture.service.blockAvailability({
      actorOwnerId: ownerId.toHexString(),
      venueId: venueId.toHexString(),
      courtId: courtId.toHexString(),
      correlationId: 'overlap',
      reason: 'Overlap',
      courtVersion: fixture.getCourtVersion(),
      startsAt: '2026-07-28T01:00:00.000Z',
      endsAt: '2026-07-28T02:00:00.000Z',
    }),
    (error: unknown) =>
      error instanceof AppError && error.code === 'INVENTORY_OVERLAP',
  );

  await fixture.service.releaseAvailability({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    courtId: courtId.toHexString(),
    slotId: blocked.id,
    expectedVersion: blocked.version,
    reason: 'Event cancelled',
    correlationId: 'open-release',
  });
  assert.equal(fixture.slots.length, 0);
});

test('payout accounts persist only tokenized metadata and await Admin verification', async () => {
  const fixture = createFixture();
  const account = await fixture.service.addPayoutAccount({
    actorOwnerId: ownerId.toHexString(),
    venueId: venueId.toHexString(),
    accountHolderName: 'Venue Operations Pvt Ltd',
    vaultProvider: 'bank-vault',
    vaultAccountToken: 'tok_account_123456',
    accountLast4: '6789',
    bankName: 'Example Bank',
    ifscCode: 'ABCD0123456',
  }) as Record<string, unknown>;

  assert.equal(account.status, 'PENDING');
  assert.equal(account.accountLast4, '6789');
  assert.equal('vaultAccountToken' in account, false);
  assert.equal(fixture.payouts[0]?.verified_by, null);
});
