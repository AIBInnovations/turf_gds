import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import {
  availabilityCursorOf,
  compareAvailability,
  decodeAvailabilityCursor,
  encodeAvailabilityCursor,
} from '../src/modules/identity/partner/partner-portal.service.js';
import { AppError } from '../src/shared/errors/app-error.js';

type Row = {
  rawDistanceMeters: number;
  courtId: string;
  startsAt: string;
  bookingType: 'FIXED_SLOT' | 'OPEN_TIME';
  availabilityId: string | null;
};

const courtA = '687f00000000000000000a01';
const courtB = '687f00000000000000000a02';
const slotA = '687f00000000000000000b01';
const slotB = '687f00000000000000000b02';

function row(overrides: Partial<Row> = {}): Row {
  return {
    rawDistanceMeters: 100,
    courtId: courtA,
    startsAt: '2026-08-03T04:30:00.000Z',
    bookingType: 'FIXED_SLOT',
    availabilityId: slotA,
    ...overrides,
  };
}

function sortRows(values: Row[]): Row[] {
  return [...values].sort((left, right) =>
    compareAvailability(left, availabilityCursorOf(right)),
  );
}

function key(value: Row): string {
  return [
    value.rawDistanceMeters,
    value.courtId,
    value.startsAt,
    value.bookingType,
    value.availabilityId ?? '',
  ].join('|');
}

test('availability ordering is a strict total order', () => {
  const rows: Row[] = [
    row({ rawDistanceMeters: 250, courtId: courtB, availabilityId: slotB }),
    row({ rawDistanceMeters: 100, bookingType: 'OPEN_TIME', availabilityId: null }),
    row({ rawDistanceMeters: 100, availabilityId: slotA }),
    // Same court, same start, different end: distinct slots whose only
    // distinguishing key component is availabilityId.
    row({ rawDistanceMeters: 100, availabilityId: slotB }),
    row({ rawDistanceMeters: 100, courtId: courtB, availabilityId: slotA }),
  ];

  const sorted = sortRows(rows);
  assert.deepEqual(
    sorted.map(key),
    [
      `100|${courtA}|2026-08-03T04:30:00.000Z|FIXED_SLOT|${slotA}`,
      `100|${courtA}|2026-08-03T04:30:00.000Z|FIXED_SLOT|${slotB}`,
      `100|${courtA}|2026-08-03T04:30:00.000Z|OPEN_TIME|`,
      `100|${courtB}|2026-08-03T04:30:00.000Z|FIXED_SLOT|${slotA}`,
      `250|${courtB}|2026-08-03T04:30:00.000Z|FIXED_SLOT|${slotB}`,
    ],
  );

  // No two distinct rows may compare equal, or paging drops one of them.
  for (const left of rows) {
    for (const right of rows) {
      const comparison = compareAvailability(left, availabilityCursorOf(right));
      if (key(left) === key(right)) {
        assert.equal(comparison, 0);
      } else {
        assert.notEqual(comparison, 0);
        // Antisymmetry.
        assert.equal(
          Math.sign(comparison),
          -Math.sign(compareAvailability(right, availabilityCursorOf(left))),
        );
      }
    }
  }
});

test('fixed slots sharing a start time are distinguishable by cursor', () => {
  const first = row({ availabilityId: slotA });
  const second = row({ availabilityId: slotB });

  // The old key omitted availabilityId, so paging past `first` also skipped
  // `second`. It must now sort strictly after.
  assert.equal(compareAvailability(second, availabilityCursorOf(first)), 1);
  assert.equal(compareAvailability(first, availabilityCursorOf(first)), 0);
});

test('a scan-resume cursor sorts before every row at the same distance', () => {
  const candidate = row({ rawDistanceMeters: 100 });

  assert.equal(compareAvailability(candidate, { d: 100 }), 1);
  assert.equal(compareAvailability(candidate, { d: 101 }), -1);
});

test('availability cursors round-trip', () => {
  for (const value of [
    availabilityCursorOf(row()),
    availabilityCursorOf(row({ bookingType: 'OPEN_TIME', availabilityId: null })),
    { d: 4231.5 },
  ]) {
    assert.deepEqual(
      decodeAvailabilityCursor(encodeAvailabilityCursor(value)),
      value,
    );
  }
});

test('legacy pipe-form cursors continue to resolve', () => {
  const legacy = Buffer.from(
    `000000004231|${courtA}|2026-08-03T04:30:00.000Z|FIXED_SLOT`,
    'utf8',
  ).toString('base64url');

  assert.deepEqual(decodeAvailabilityCursor(legacy), {
    d: 4231,
    c: courtA,
    s: '2026-08-03T04:30:00.000Z',
    b: 'FIXED_SLOT',
  });
});

test('malformed cursors are rejected instead of silently returning a wrong page', () => {
  const badCursors = [
    Buffer.from('{', 'utf8').toString('base64url'),
    Buffer.from('{"d":"x"}', 'utf8').toString('base64url'),
    Buffer.from('{"d":1,"b":"NOPE"}', 'utf8').toString('base64url'),
    Buffer.from('not-a-cursor', 'utf8').toString('base64url'),
  ];

  for (const cursor of badCursors) {
    assert.throws(
      () => decodeAvailabilityCursor(cursor),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'INVALID_CURSOR' &&
        error.statusCode === 400,
    );
  }
});

test('an absent cursor yields no pagination position', () => {
  assert.equal(decodeAvailabilityCursor(undefined), null);
  assert.equal(decodeAvailabilityCursor(''), null);
});

test('cursor ordering matches sort ordering for synthesized open-time rows', () => {
  // An OPEN_TIME row has no stored id, but (courtId, startsAt) makes it unique
  // within a request, so it still participates in the total order.
  const open = row({ bookingType: 'OPEN_TIME', availabilityId: null });
  const fixed = row({ bookingType: 'FIXED_SLOT', availabilityId: slotA });

  assert.equal(compareAvailability(open, availabilityCursorOf(fixed)), 1);
  assert.equal(compareAvailability(fixed, availabilityCursorOf(open)), -1);
  assert.deepEqual(availabilityCursorOf(open), {
    d: 100,
    c: courtA,
    s: '2026-08-03T04:30:00.000Z',
    b: 'OPEN_TIME',
  });
});

test('ObjectId hex ordering is consistent between sort and cursor comparison', () => {
  // Guards the switch away from localeCompare, whose ICU collation does not
  // agree with the < / > used by the cursor filter.
  const ids = Array.from({ length: 25 }, () => new ObjectId().toHexString());
  const rows = ids.map((courtId) => row({ courtId }));
  const sorted = sortRows(rows);

  for (let index = 1; index < sorted.length; index += 1) {
    assert.equal(
      compareAvailability(sorted[index]!, availabilityCursorOf(sorted[index - 1]!)),
      1,
    );
  }
});
