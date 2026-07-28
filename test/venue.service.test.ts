import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { VenueRepository } from '../src/modules/venue/venue.repository.js';
import { createVenueService } from '../src/modules/venue/venue.service.js';
import type { VenueDocument } from '../src/modules/venue/venue.types.js';

const fixedNow = new Date('2026-07-28T08:00:00.000Z');

test('Venue creates the initial onboarding aggregate with canonical defaults', async () => {
  let insertedVenue: VenueDocument | undefined;
  const repository: VenueRepository = {
    async insertInitialVenue(venue) {
      insertedVenue = venue;
    },
    async approveVenue() {
      return true;
    },
    async findById() {
      return null;
    },
    async updateProfile() {
      return null;
    },
    async appendMedia() {
      return null;
    },
  };
  const service = createVenueService({ repository });

  await service.createInitialVenue(
    {
      venueId: new ObjectId('687f00000000000000000050'),
      legalName: ' Green Arena Private Limited ',
      displayName: ' Green Arena ',
      timezone: ' Asia/Kolkata ',
      address: {
        line1: ' MG Road ',
        city: ' Bengaluru ',
        state: ' Karnataka ',
        postalCode: ' 560001 ',
        country: ' in ',
      },
      latitude: 12.9716,
      longitude: 77.5946,
      createdAt: fixedNow,
    },
    undefined as never,
  );

  assert.equal(insertedVenue?.status, 'PENDING_APPROVAL');
  assert.equal(insertedVenue?.currency, 'INR');
  assert.equal(insertedVenue?.environment, 'PRODUCTION');
  assert.deepEqual(insertedVenue?.geo.coordinates, [77.5946, 12.9716]);
  assert.equal(insertedVenue?.address.country, 'IN');
});

test('Venue approval passes audit context to its repository', async () => {
  let approvalInput:
    | Parameters<VenueRepository['approveVenue']>[0]
    | undefined;
  const repository: VenueRepository = {
    async insertInitialVenue() {},
    async approveVenue(input) {
      approvalInput = input;
      return true;
    },
    async findById() {
      return null;
    },
    async updateProfile() {
      return null;
    },
    async appendMedia() {
      return null;
    },
  };
  const service = createVenueService({
    repository,
    now: () => fixedNow,
  });

  await service.approveVenue(
    {
      venueId: '687f00000000000000000050',
      adminId: '687f00000000000000000051',
      correlationId: 'request-1',
    },
    undefined as never,
  );

  assert.equal(approvalInput?.venueId.toHexString(), '687f00000000000000000050');
  assert.equal(approvalInput?.adminId.toHexString(), '687f00000000000000000051');
  assert.equal(approvalInput?.correlationId, 'request-1');
  assert.equal(approvalInput?.now, fixedNow);
});
