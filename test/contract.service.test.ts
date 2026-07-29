import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId, type ClientSession } from 'mongodb';

import type { ContractRepository } from '../src/modules/contracts/contract.repository.js';
import {
  createContractService,
  type SaveContractInput,
} from '../src/modules/contracts/contract.service.js';
import type { PartnerVenueContractDocument } from '../src/modules/contracts/contract.types.js';
import type { PartnerDocument } from '../src/modules/identity/partner/partner-access.types.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';
import type {
  DatabaseConnection,
  TransactionContext,
} from '../src/shared/database/database-connection.js';
import { AppError } from '../src/shared/errors/app-error.js';

const partnerId = new ObjectId('687f00000000000000000200');
const venueId = new ObjectId('687f00000000000000000201');
const adminId = new ObjectId('687f00000000000000000202');
const fixedNow = new Date('2026-07-29T10:00:00.000Z');

function saveInput(
  overrides: Partial<SaveContractInput> = {},
): SaveContractInput {
  return {
    adminId: adminId.toHexString(),
    partnerId: partnerId.toHexString(),
    venueId: venueId.toHexString(),
    commissionRateBps: 1_000,
    taxRateBps: 180,
    settlementCycle: 'WEEKLY',
    settlementLagDays: 2,
    allowedBookingModes: 'BOTH',
    cancellationTerms: {
      cancellationAllowed: true,
      defaultRefundBps: 0,
      releaseInventory: false,
    },
    refundRules: [
      {
        minMinutesBeforeStart: 1_440,
        refundBps: 10_000,
        releaseInventory: true,
      },
      {
        minMinutesBeforeStart: 120,
        refundBps: 5_000,
        releaseInventory: true,
      },
    ],
    resaleCutoffMinutes: 60,
    effectiveFrom: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function createFixture(options: {
  partnerStatus?: PartnerDocument['status'];
  venueStatus?: VenueDocument['status'];
} = {}) {
  const contracts: PartnerVenueContractDocument[] = [];
  const partner = {
    _id: partnerId,
    status: options.partnerStatus ?? 'ACTIVE',
  } as PartnerDocument;
  const venue = {
    _id: venueId,
    status: options.venueStatus ?? 'ACTIVE',
  } as VenueDocument;
  const repository: ContractRepository = {
    async findPartner(id) {
      return id.equals(partnerId) ? partner : null;
    },
    async findVenue(id) {
      return id.equals(venueId) ? venue : null;
    },
    async findById(id) {
      return contracts.find((item) => item._id.equals(id)) ?? null;
    },
    async list(filters) {
      return contracts.filter(
        (item) =>
          (!filters.partnerId ||
            item.partner_id.equals(filters.partnerId)) &&
          (!filters.venueId || item.venue_id.equals(filters.venueId)),
      );
    },
    async findLatest(requestPartnerId, requestVenueId) {
      return contracts.find(
        (item) =>
          item.partner_id.equals(requestPartnerId) &&
          item.venue_id.equals(requestVenueId) &&
          item.status === 'ACTIVE',
      ) ?? null;
    },
    async findEffective(requestPartnerId, requestVenueId, at) {
      return contracts
        .filter(
          (item) =>
            item.partner_id.equals(requestPartnerId) &&
            item.venue_id.equals(requestVenueId) &&
            item.status === 'ACTIVE' &&
            item.effective_from <= at &&
            (!item.effective_to || item.effective_to > at),
        )
        .sort(
          (left, right) =>
            right.effective_from.getTime() -
            left.effective_from.getTime(),
        )[0] ?? null;
    },
    async supersede(input) {
      const contract = contracts.find(
        (item) => item._id.equals(input.id) && item.status === 'ACTIVE',
      );
      if (!contract) {
        return false;
      }
      contract.effective_to = input.effectiveTo;
      return true;
    },
    async insert(document) {
      contracts.push(document);
    },
  };
  const database: DatabaseConnection = {
    db: undefined as never,
    async connect() {},
    async ping() {},
    async close() {},
    async withTransaction<T>(
      operation: (context: TransactionContext) => Promise<T>,
    ) {
      return operation({
        db: undefined as never,
        session: {} as ClientSession,
      });
    },
  };

  return {
    contracts,
    service: createContractService({
      repository,
      database,
      now: () => fixedNow,
    }),
  };
}

test('contract creation normalizes commercial and cancellation terms', async () => {
  const fixture = createFixture();

  const result = await fixture.service.saveVersion(saveInput());

  assert.equal(result.termsVersion, 1);
  assert.equal(result.status, 'ACTIVE');
  assert.equal(result.settlementCycle, 'WEEKLY');
  assert.deepEqual(
    result.refundRules.map((rule) => rule.minMinutesBeforeStart),
    [1_440, 120],
  );
});

test('contract changes create a new effective version and preserve history', async () => {
  const fixture = createFixture();
  const first = await fixture.service.saveVersion(saveInput());
  const second = await fixture.service.saveVersion(
    saveInput({
      commissionRateBps: 1_200,
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    }),
  );

  assert.equal(second.termsVersion, 2);
  assert.equal(second.termsVersion, 2);
  assert.equal(fixture.contracts[0]?.status, 'ACTIVE');
  assert.equal(
    fixture.contracts[0]?.effective_to?.toISOString(),
    '2026-09-01T00:00:00.000Z',
  );
  assert.equal((await fixture.service.get(first.id)).commissionRateBps, 1_000);
});

test('effective lookup supports historical and future versions', async () => {
  const fixture = createFixture();
  await fixture.service.saveVersion(saveInput());
  await fixture.service.saveVersion(
    saveInput({
      allowedBookingModes: 'OPEN_TIME',
      effectiveFrom: '2026-09-01T00:00:00.000Z',
    }),
  );

  const historical = await fixture.service.getActiveContract({
    partnerId: partnerId.toHexString(),
    venueId: venueId.toHexString(),
    at: new Date('2026-08-15T00:00:00.000Z'),
  });
  const futureAllowed = await fixture.service.isBookingModeAllowed({
    partnerId: partnerId.toHexString(),
    venueId: venueId.toHexString(),
    bookingMode: 'OPEN_TIME',
    at: new Date('2026-09-15T00:00:00.000Z'),
  });
  const futureFixedAllowed = await fixture.service.isBookingModeAllowed({
    partnerId: partnerId.toHexString(),
    venueId: venueId.toHexString(),
    bookingMode: 'FIXED_SLOT',
    at: new Date('2026-09-15T00:00:00.000Z'),
  });

  assert.equal(historical.termsVersion, 1);
  assert.equal(futureAllowed, true);
  assert.equal(futureFixedAllowed, false);
});

test('cancellation terms are returned as a snapshottable contract capability', async () => {
  const fixture = createFixture();
  await fixture.service.saveVersion(saveInput());

  const terms = await fixture.service.getCancellationTerms({
    partnerId: partnerId.toHexString(),
    venueId: venueId.toHexString(),
    at: new Date('2026-08-15T00:00:00.000Z'),
  });

  assert.equal(terms.termsVersion, 1);
  assert.equal(terms.refundRules[0]?.refundBps, 10_000);
  assert.equal(terms.resaleCutoffMinutes, 60);
});

test('contract validation rejects invalid percentages, cycles, and refund tiers', async () => {
  const cases: SaveContractInput[] = [
    saveInput({ commissionRateBps: 9_500, taxRateBps: 600 }),
    saveInput({ commissionRateBps: 1_000.5 }),
    saveInput({ settlementCycle: 'INVALID' as 'WEEKLY' }),
    saveInput({
      settlementLagDays: -1,
    }),
    saveInput({
      settlementLagDays: 1.5,
    }),
    saveInput({
      allowedBookingModes: 'INVALID' as 'FIXED_SLOT',
    }),
    saveInput({
      refundRules: [{
        minMinutesBeforeStart: 60,
        refundBps: 10_001,
        releaseInventory: true,
      }],
    }),
    saveInput({
      refundRules: [
        {
          minMinutesBeforeStart: 60,
          refundBps: 5_000,
          releaseInventory: true,
        },
        {
          minMinutesBeforeStart: 60,
          refundBps: 0,
          releaseInventory: false,
        },
      ],
    }),
    saveInput({
      cancellationTerms: {
        cancellationAllowed: false,
        defaultRefundBps: 0,
        releaseInventory: false,
      },
      refundRules: [{
        minMinutesBeforeStart: 60,
        refundBps: 0,
        releaseInventory: false,
      }],
    }),
  ];

  for (const values of cases) {
    await assert.rejects(
      createFixture().service.saveVersion(values),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_CONTRACT_TERMS',
    );
  }
});

test('contract percentage boundaries and all settlement cycles are accepted', async () => {
  const daily = createFixture();
  const weekly = createFixture();
  const monthly = createFixture();

  const dailyResult = await daily.service.saveVersion(
    saveInput({
      commissionRateBps: 10_000,
      taxRateBps: 0,
      settlementCycle: 'T_PLUS_N',
      settlementLagDays: 1,
    }),
  );
  const weeklyResult = await weekly.service.saveVersion(
    saveInput({
      commissionRateBps: 0,
      taxRateBps: 0,
      settlementCycle: 'WEEKLY',
      settlementLagDays: 7,
    }),
  );
  const monthlyResult = await monthly.service.saveVersion(
    saveInput({
      settlementCycle: 'MONTHLY',
      settlementLagDays: 2,
    }),
  );

  assert.equal(dailyResult.commissionRateBps, 10_000);
  assert.equal(weeklyResult.settlementCycle, 'WEEKLY');
  assert.equal(monthlyResult.settlementCycle, 'MONTHLY');
});

test('effective contract lookup rejects gaps before the first version', async () => {
  const fixture = createFixture();
  await fixture.service.saveVersion(saveInput());

  await assert.rejects(
    fixture.service.getActiveContract({
      partnerId: partnerId.toHexString(),
      venueId: venueId.toHexString(),
      at: new Date('2026-07-31T23:59:59.999Z'),
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'ACTIVE_CONTRACT_NOT_FOUND',
  );
});

test('effective boundary switches exactly to the new contract version', async () => {
  const fixture = createFixture();
  await fixture.service.saveVersion(saveInput());
  const second = await fixture.service.saveVersion(
    saveInput({
      effectiveFrom: '2026-09-01T00:00:00.000Z',
      commissionRateBps: 1_200,
    }),
  );

  const atBoundary = await fixture.service.getActiveContract({
    partnerId: partnerId.toHexString(),
    venueId: venueId.toHexString(),
    at: new Date('2026-09-01T00:00:00.000Z'),
  });

  assert.equal(atBoundary.id, second.id);
  assert.equal(atBoundary.commissionRateBps, 1_200);
});

test('new versions must have increasing effective dates', async () => {
  const fixture = createFixture();
  await fixture.service.saveVersion(saveInput());

  await assert.rejects(
    fixture.service.saveVersion(saveInput()),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'CONTRACT_EFFECTIVE_DATE_CONFLICT',
  );
});

test('active contracts require eligible Partner and Venue records', async () => {
  await assert.rejects(
    createFixture({ partnerStatus: 'SUSPENDED' }).service.saveVersion(
      saveInput(),
    ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'CONTRACT_PARTNER_NOT_ELIGIBLE',
  );
  await assert.rejects(
    createFixture({ venueStatus: 'PENDING' }).service.saveVersion(
      saveInput(),
    ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'CONTRACT_VENUE_NOT_ELIGIBLE',
  );
});
