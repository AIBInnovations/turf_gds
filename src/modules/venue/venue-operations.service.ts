import { ObjectId } from 'mongodb';

import type { OwnerAccessService } from '../identity/owner/owner-access.service.js';
import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { CourtRepository } from './court.repository.js';
import type { CourtDocument } from './court.types.js';
import type {
  PricingRuleDocument,
  SlotDocument,
  VenuePayoutAccountDocument,
} from './inventory.types.js';
import type { VenueOperationsRepository } from './venue-operations.repository.js';
import type { VenueRepository } from './venue.repository.js';

export interface VenueOperationsService {
  createPricingRule(input: PricingInput): Promise<object>;
  listPricingRules(input: ScopedCourt): Promise<object[]>;
  updatePricingRule(input: PricingUpdateInput): Promise<object>;
  generateFixedSlots(input: ScopedCourt & {
    actorOwnerId: string;
    dateFrom: string;
    dateTo: string;
    correlationId: string;
  }): Promise<{ created: number }>;
  listInventory(input: ScopedCourt & {
    actorOwnerId: string;
    from: string;
    to: string;
  }): Promise<object[]>;
  blockAvailability(input: {
    actorOwnerId: string;
    venueId: string;
    courtId: string;
    correlationId: string;
    reason: string;
    slotId?: string;
    slotVersion?: number;
    courtVersion?: number;
    startsAt?: string;
    endsAt?: string;
  }): Promise<object>;
  releaseAvailability(input: {
    actorOwnerId: string;
    venueId: string;
    courtId: string;
    slotId: string;
    expectedVersion: number;
    reason: string;
    correlationId: string;
  }): Promise<void | object>;
  addPayoutAccount(input: {
    actorOwnerId: string;
    venueId: string;
    accountHolderName: string;
    vaultProvider: string;
    vaultAccountToken: string;
    accountLast4: string;
    bankName: string;
    ifscCode: string;
  }): Promise<object>;
  listPayoutAccounts(input: {
    actorOwnerId: string;
    venueId: string;
  }): Promise<object[]>;
  searchAvailability(input: {
    courtId: string;
    from: Date;
    to: Date;
  }): Promise<object[]>;
}

interface ScopedCourt {
  actorOwnerId: string;
  venueId: string;
  courtId: string;
}

interface PricingInput extends ScopedCourt {
  name: string;
  dayOfWeek?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  priceMinor: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo?: string;
  priority: number;
}

interface PricingUpdateInput extends ScopedCourt {
  pricingRuleId: string;
  name?: string;
  dayOfWeek?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  priceMinor?: number;
  currency?: string;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  priority?: number;
  active?: boolean;
}

export function createVenueOperationsService(input: {
  repository: VenueOperationsRepository;
  venueRepository: VenueRepository;
  courtRepository: CourtRepository;
  ownerAccessService: OwnerAccessService;
  database: DatabaseConnection;
  now?: () => Date;
}): VenueOperationsService {
  const now = input.now ?? (() => new Date());

  async function scopedCourt(
    values: ScopedCourt,
    permission:
      | 'MANAGE_PRICING'
      | 'MANAGE_AVAILABILITY',
  ): Promise<CourtDocument> {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      permission,
    );
    const court = await input.courtRepository.findByIdAndVenue(
      oid(values.courtId),
      oid(values.venueId),
    );
    if (!court) {
      throw notFound('COURT_NOT_FOUND', 'Court was not found');
    }
    return court;
  }

  async function createPricingRule(values: PricingInput) {
    await scopedCourt(values, 'MANAGE_PRICING');
    const timestamp = now();
    const rule = pricingDocument(values, timestamp);
    await input.repository.insertPricingRule(rule);
    return presentPricing(rule);
  }

  async function listPricingRules(values: ScopedCourt) {
    await scopedCourt(values, 'MANAGE_PRICING');
    return (
      await input.repository.listPricingRules(oid(values.courtId))
    ).map(presentPricing);
  }

  async function updatePricingRule(values: PricingUpdateInput) {
    await scopedCourt(values, 'MANAGE_PRICING');
    const id = oid(values.pricingRuleId);
    const courtId = oid(values.courtId);
    const existing = await input.repository.findPricingRule(id, courtId);
    if (!existing) {
      throw notFound('PRICING_RULE_NOT_FOUND', 'Pricing rule was not found');
    }
    const effectiveTo =
      values.effectiveTo === null
        ? undefined
        : values.effectiveTo ?? existing.effective_to?.toISOString();
    const merged: PricingInput = {
      actorOwnerId: values.actorOwnerId,
      venueId: values.venueId,
      courtId: values.courtId,
      name: values.name ?? existing.name,
      dayOfWeek: values.dayOfWeek ?? existing.day_of_week,
      startTime: values.startTime ?? existing.start_time,
      endTime: values.endTime ?? existing.end_time,
      priceMinor: values.priceMinor ?? existing.price_minor,
      currency: values.currency ?? existing.currency,
      effectiveFrom:
        values.effectiveFrom ?? existing.effective_from.toISOString(),
      priority: values.priority ?? existing.priority,
      ...(effectiveTo ? { effectiveTo } : {}),
    };
    const validated = pricingDocument(
      merged,
      existing.created_at,
      existing._id,
    );
    const updated = await input.repository.updatePricingRule(
      id,
      courtId,
      {
        name: validated.name,
        day_of_week: validated.day_of_week,
        start_time: validated.start_time,
        end_time: validated.end_time,
        price_minor: validated.price_minor,
        currency: validated.currency,
        effective_from: validated.effective_from,
        effective_to: validated.effective_to,
        priority: validated.priority,
        active: values.active ?? existing.active,
        updated_at: now(),
      },
    );
    if (!updated) {
      throw notFound('PRICING_RULE_NOT_FOUND', 'Pricing rule was not found');
    }
    return presentPricing(updated);
  }

  async function generateFixedSlots(
    values: Parameters<VenueOperationsService['generateFixedSlots']>[0],
  ) {
    const court = await scopedCourt(values, 'MANAGE_AVAILABILITY');
    if (
      court.status !== 'AVAILABLE' ||
      !['FIXED_SLOT', 'BOTH'].includes(court.booking_mode)
    ) {
      return { created: 0 };
    }
    const venue = await input.venueRepository.findById(oid(values.venueId));
    if (!venue || venue.status !== 'ACTIVE') {
      return { created: 0 };
    }
    const dates = dateRange(values.dateFrom, values.dateTo, 31);
    const rules = (await input.repository.listPricingRules(court._id))
      .filter((rule) => rule.active)
      .sort((a, b) => b.priority - a.priority);
    const timestamp = now();
    const slots: SlotDocument[] = [];
    for (const date of dates) {
      const day = isoDay(date);
      const hours = court.operating_hours.entries.find(
        (item) => item.day_of_week === day,
      );
      if (!hours) continue;
      let cursor = zonedToUtc(date, hours.opens_at, venue.timezone);
      const close = zonedToUtc(date, hours.closes_at, venue.timezone);
      while (
        cursor.getTime() + court.min_booking_minutes * 60_000 <=
        close.getTime()
      ) {
        const localTime = formatTime(cursor, venue.timezone);
        const rule = rules.find(
          (candidate) =>
            (candidate.day_of_week === null ||
              candidate.day_of_week === day) &&
            (candidate.start_time === null ||
              localTime >= candidate.start_time) &&
            (candidate.end_time === null ||
              localTime < candidate.end_time) &&
            cursor >= candidate.effective_from &&
            (!candidate.effective_to || cursor < candidate.effective_to),
        );
        if (rule) {
          const endsAt = new Date(
            cursor.getTime() + court.min_booking_minutes * 60_000,
          );
          slots.push({
            _id: new ObjectId(),
            court_id: court._id,
            venue_id: venue._id,
            environment: venue.environment,
            booking_type: 'FIXED_SLOT',
            starts_at: cursor,
            ends_at: endsAt,
            price_minor: rule.price_minor,
            currency: 'INR',
            status: 'AVAILABLE',
            hold_id: null,
            hold_partner_id: null,
            hold_expires_at: null,
            hold_created_at: null,
            source: 'SYSTEM_GENERATED',
            booking_id: null,
            audit_history: [{
              event_type: 'SLOT_GENERATED',
              actor_type: 'VENUE_OWNER',
              actor_id: oid(values.actorOwnerId),
              previous_status: null,
              new_status: 'AVAILABLE',
              reason: 'Rolling inventory generation',
              correlation_id: values.correlationId,
              occurred_at: timestamp,
            }],
            version: 1,
            created_at: timestamp,
            updated_at: timestamp,
          });
          cursor = endsAt;
        } else {
          cursor = new Date(
            cursor.getTime() + court.booking_increment_minutes * 60_000,
          );
        }
      }
    }
    if (slots.length === 0) {
      return { created: 0 };
    }
    const existingInventory = await input.repository.listSlots(
      court._id,
      slots[0]!.starts_at,
      slots[slots.length - 1]!.ends_at,
    );
    const generatable = slots.filter(
      (slot) =>
        !existingInventory.some(
          (candidate) =>
            ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'].includes(
              candidate.status,
            ) &&
            candidate.starts_at < slot.ends_at &&
            candidate.ends_at > slot.starts_at,
        ),
    );
    return {
      created: await input.repository.bulkUpsertSlots(generatable),
    };
  }

  async function listInventory(
    values: Parameters<VenueOperationsService['listInventory']>[0],
  ) {
    await scopedCourt(values, 'MANAGE_AVAILABILITY');
    return (
      await input.repository.listSlots(
        oid(values.courtId),
        date(values.from, 'from'),
        date(values.to, 'to'),
      )
    ).map(presentSlot);
  }

  async function blockAvailability(
    values: Parameters<VenueOperationsService['blockAvailability']>[0],
  ) {
    const court = await scopedCourt(values, 'MANAGE_AVAILABILITY');
    const reason = required(values.reason, 'reason');
    if (values.slotId) {
      if (!values.slotVersion) {
        throw invalid('SLOT_VERSION_REQUIRED', 'Slot version is required');
      }
      const updated = await input.repository.updateFixedSlot({
        slotId: oid(values.slotId),
        courtId: court._id,
        expectedVersion: values.slotVersion,
        fromStatus: 'AVAILABLE',
        toStatus: 'BLOCKED',
        actorOwnerId: oid(values.actorOwnerId),
        reason,
        correlationId: values.correlationId,
        now: now(),
      });
      if (!updated) {
        throw conflict(
          'SLOT_BLOCK_CONFLICT',
          'Slot is held, booked, blocked, or stale',
        );
      }
      return presentSlot(updated);
    }
    if (
      !values.startsAt ||
      !values.endsAt ||
      values.courtVersion === undefined
    ) {
      throw invalid(
        'OPEN_BLOCK_FIELDS_REQUIRED',
        'Open-time blocks require start, end, and Court version',
      );
    }
    if (!['OPEN_TIME', 'BOTH'].includes(court.booking_mode)) {
      throw conflict(
        'COURT_MODE_NOT_ALLOWED',
        'Court does not allow open-time inventory',
      );
    }
    const startsAt = date(values.startsAt, 'startsAt');
    const endsAt = date(values.endsAt, 'endsAt');
    const venue = await input.venueRepository.findById(oid(values.venueId));
    if (!venue) throw notFound('VENUE_NOT_FOUND', 'Venue was not found');
    validateInterval(court, venue.timezone, startsAt, endsAt);
    const timestamp = now();
    const slot: SlotDocument = {
      _id: new ObjectId(),
      court_id: court._id,
      venue_id: venue._id,
      environment: venue.environment,
      booking_type: 'OPEN_TIME',
      starts_at: startsAt,
      ends_at: endsAt,
      price_minor: null,
      currency: 'INR',
      status: 'BLOCKED',
      hold_id: null,
      hold_partner_id: null,
      hold_expires_at: null,
      hold_created_at: null,
      source: 'OWNER_DASHBOARD',
      booking_id: null,
      audit_history: [{
        event_type: 'SLOT_BLOCKED',
        actor_type: 'VENUE_OWNER',
        actor_id: oid(values.actorOwnerId),
        previous_status: null,
        new_status: 'BLOCKED',
        reason,
        correlation_id: values.correlationId,
        occurred_at: timestamp,
      }],
      version: 1,
      created_at: timestamp,
      updated_at: timestamp,
    };
    await input.database.withTransaction(async ({ session }) => {
      const locked = await input.repository.lockCourtForInventory({
        courtId: court._id,
        venueId: oid(values.venueId),
        expectedVersion: values.courtVersion!,
        actorOwnerId: oid(values.actorOwnerId),
        correlationId: values.correlationId,
        now: timestamp,
        session,
      });
      if (!locked) {
        throw conflict(
          'COURT_VERSION_CONFLICT',
          'Court inventory changed concurrently',
        );
      }
      const overlap = await input.repository.findOverlap(
        court._id,
        venue.environment,
        startsAt,
        endsAt,
        session,
      );
      if (overlap) {
        throw conflict(
          'INVENTORY_OVERLAP',
          'The interval overlaps unavailable inventory',
        );
      }
      await input.repository.insertOpenBlock(slot, session);
    });
    return presentSlot(slot);
  }

  async function releaseAvailability(
    values: Parameters<VenueOperationsService['releaseAvailability']>[0],
  ) {
    await scopedCourt(values, 'MANAGE_AVAILABILITY');
    const slot = await input.repository.findSlot(
      oid(values.slotId),
      oid(values.courtId),
    );
    if (!slot || slot.status !== 'BLOCKED') {
      throw conflict(
        'SLOT_RELEASE_CONFLICT',
        'Only blocked inventory can be released',
      );
    }
    if (slot.booking_type === 'OPEN_TIME') {
      const deleted = await input.repository.deleteOpenBlock({
        slotId: slot._id,
        courtId: slot.court_id,
        expectedVersion: values.expectedVersion,
      });
      if (!deleted) {
        throw conflict('SLOT_VERSION_CONFLICT', 'Slot changed concurrently');
      }
      return;
    }
    const updated = await input.repository.updateFixedSlot({
      slotId: slot._id,
      courtId: slot.court_id,
      expectedVersion: values.expectedVersion,
      fromStatus: 'BLOCKED',
      toStatus: 'AVAILABLE',
      actorOwnerId: oid(values.actorOwnerId),
      reason: required(values.reason, 'reason'),
      correlationId: values.correlationId,
      now: now(),
    });
    if (!updated) {
      throw conflict('SLOT_VERSION_CONFLICT', 'Slot changed concurrently');
    }
    return presentSlot(updated);
  }

  async function addPayoutAccount(
    values: Parameters<VenueOperationsService['addPayoutAccount']>[0],
  ) {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'VIEW_FINANCE',
    );
    if (
      !/^[0-9]{4}$/.test(values.accountLast4) ||
      values.vaultAccountToken.trim().length < 12 ||
      !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(values.ifscCode.toUpperCase())
    ) {
      throw invalid(
        'INVALID_PAYOUT_ACCOUNT',
        'Tokenized payout-account metadata is invalid',
      );
    }
    const timestamp = now();
    const account: VenuePayoutAccountDocument = {
      _id: new ObjectId(),
      venue_id: oid(values.venueId),
      account_holder_name: required(
        values.accountHolderName,
        'accountHolderName',
      ),
      vault_provider: required(values.vaultProvider, 'vaultProvider'),
      vault_account_token: values.vaultAccountToken.trim(),
      account_last4: values.accountLast4,
      bank_name: required(values.bankName, 'bankName'),
      ifsc_code: values.ifscCode.toUpperCase(),
      status: 'PENDING',
      verified_by: null,
      verified_at: null,
      verification_failure_reason: null,
      verification_method: 'PENNY_DROP',
      audit_history: [],
      created_at: timestamp,
      updated_at: timestamp,
    };
    try {
      await input.repository.insertPayoutAccount(account);
    } catch (error) {
      if (duplicate(error)) {
        throw conflict(
          'PAYOUT_ACCOUNT_ALREADY_EXISTS',
          'This tokenized payout account already exists',
        );
      }
      throw error;
    }
    return presentPayout(account);
  }

  async function listPayoutAccounts(
    values: Parameters<VenueOperationsService['listPayoutAccounts']>[0],
  ) {
    await input.ownerAccessService.requirePermission(
      values.actorOwnerId,
      values.venueId,
      'VIEW_FINANCE',
    );
    return (
      await input.repository.listPayoutAccounts(oid(values.venueId))
    ).map(presentPayout);
  }

  async function searchAvailability(
    values: Parameters<VenueOperationsService['searchAvailability']>[0],
  ) {
    const inventory = await input.repository.listSlots(
      oid(values.courtId),
      values.from,
      values.to,
    );
    return inventory
      .filter(
        (slot) =>
          slot.status === 'AVAILABLE' &&
          !inventory.some(
            (candidate) =>
              !candidate._id.equals(slot._id) &&
              ['HELD', 'BOOKED', 'BLOCKED', 'UNAVAILABLE'].includes(
                candidate.status,
              ) &&
              candidate.starts_at < slot.ends_at &&
              candidate.ends_at > slot.starts_at,
          ),
      )
      .map(presentSlot);
  }

  return {
    createPricingRule,
    listPricingRules,
    updatePricingRule,
    generateFixedSlots,
    listInventory,
    blockAvailability,
    releaseAvailability,
    addPayoutAccount,
    listPayoutAccounts,
    searchAvailability,
  };
}

function pricingDocument(
  input: PricingInput,
  createdAt: Date,
  id = new ObjectId(),
): PricingRuleDocument {
  if (
    (input.dayOfWeek !== undefined &&
      input.dayOfWeek !== null &&
      (!Number.isInteger(input.dayOfWeek) ||
        input.dayOfWeek < 1 ||
        input.dayOfWeek > 7)) ||
    (input.startTime != null && !time(input.startTime)) ||
    (input.endTime != null && !time(input.endTime)) ||
    ((input.startTime === null) !== (input.endTime === null)) ||
    (input.startTime != null &&
      input.endTime != null &&
      input.startTime >= input.endTime) ||
    !Number.isSafeInteger(input.priceMinor) ||
    input.priceMinor < 0 ||
    input.currency !== 'INR' ||
    !Number.isInteger(input.priority)
  ) {
    throw invalid('INVALID_PRICING_RULE', 'Pricing rule is invalid');
  }
  const from = date(input.effectiveFrom, 'effectiveFrom');
  const to = input.effectiveTo
    ? date(input.effectiveTo, 'effectiveTo')
    : null;
  if (to && to <= from) {
    throw invalid(
      'INVALID_PRICING_EFFECTIVE_RANGE',
      'Pricing effective end must follow its start',
    );
  }
  return {
    _id: id,
    court_id: oid(input.courtId),
    name: required(input.name, 'name'),
    day_of_week: input.dayOfWeek ?? null,
    start_time: input.startTime ?? null,
    end_time: input.endTime ?? null,
    price_minor: input.priceMinor,
    currency: 'INR',
    effective_from: from,
    effective_to: to,
    priority: input.priority,
    active: true,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function validateInterval(
  court: CourtDocument,
  timezone: string,
  startsAt: Date,
  endsAt: Date,
): void {
  const minutes = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  const localStart = formatTime(startsAt, timezone);
  const localEnd = formatTime(endsAt, timezone);
  const hours = court.operating_hours.entries.find(
    (value) => value.day_of_week === isoDay(localDate(startsAt, timezone)),
  );
  if (
    endsAt <= startsAt ||
    minutes < court.min_booking_minutes ||
    minutes % court.booking_increment_minutes !== 0 ||
    !hours ||
    localStart < hours.opens_at ||
    localEnd > hours.closes_at
  ) {
    throw invalid(
      'INVALID_AVAILABILITY_INTERVAL',
      'Interval violates Court duration, increment, or operating hours',
    );
  }
}

function dateRange(from: string, to: string, maxDays: number): string[] {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  const count = Math.floor((end.getTime() - start.getTime()) / 86_400_000) + 1;
  if (count < 1 || count > maxDays) {
    throw invalid('INVALID_DATE_RANGE', `Date range must be 1-${maxDays} days`);
  }
  return Array.from({ length: count }, (_, index) =>
    new Date(start.getTime() + index * 86_400_000)
      .toISOString()
      .slice(0, 10),
  );
}

function parseDateOnly(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw invalid('INVALID_DATE', 'Date must use YYYY-MM-DD');
  }
  const result = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(result.getTime()) || result.toISOString().slice(0, 10) !== value) {
    throw invalid('INVALID_DATE', 'Date is invalid');
  }
  return result;
}

function zonedToUtc(day: string, value: string, timezone: string): Date {
  const [year, month, datePart] = day.split('-').map(Number);
  const [hour, minute] = value.split(':').map(Number);
  const desired = Date.UTC(year!, month! - 1, datePart!, hour!, minute!);
  let instant = desired;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(new Date(instant))
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, Number(part.value)]),
    );
    const actual = Date.UTC(
      parts['year']!,
      parts['month']! - 1,
      parts['day']!,
      parts['hour']!,
      parts['minute']!,
    );
    instant += desired - actual;
  }
  return new Date(instant);
}

function localDate(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value);
}

function formatTime(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

function isoDay(day: string): number {
  const value = new Date(`${day}T00:00:00.000Z`).getUTCDay();
  return value === 0 ? 7 : value;
}

function presentPricing(value: PricingRuleDocument) {
  return {
    id: value._id.toHexString(),
    courtId: value.court_id.toHexString(),
    name: value.name,
    dayOfWeek: value.day_of_week,
    startTime: value.start_time,
    endTime: value.end_time,
    priceMinor: value.price_minor,
    currency: value.currency,
    effectiveFrom: value.effective_from.toISOString(),
    effectiveTo: value.effective_to?.toISOString() ?? null,
    priority: value.priority,
    active: value.active,
  };
}

function presentSlot(value: SlotDocument) {
  return {
    id: value._id.toHexString(),
    courtId: value.court_id.toHexString(),
    environment: value.environment,
    bookingType: value.booking_type,
    startsAt: value.starts_at.toISOString(),
    endsAt: value.ends_at.toISOString(),
    priceMinor: value.price_minor,
    currency: value.currency,
    status: value.status,
    version: value.version,
  };
}

function presentPayout(value: VenuePayoutAccountDocument) {
  return {
    id: value._id.toHexString(),
    venueId: value.venue_id.toHexString(),
    accountHolderName: value.account_holder_name,
    vaultProvider: value.vault_provider,
    accountLast4: value.account_last4,
    bankName: value.bank_name,
    ifscCode: value.ifsc_code,
    status: value.status,
    verifiedAt: value.verified_at?.toISOString() ?? null,
    verificationMethod: value.verification_method,
  };
}

function oid(value: string): ObjectId {
  if (!ObjectId.isValid(value)) throw invalid('INVALID_ID', 'Identifier is invalid');
  return new ObjectId(value);
}
function date(value: string, field: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw invalid('INVALID_DATE', `${field} is invalid`);
  return result;
}
function time(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}
function required(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw invalid('FIELD_REQUIRED', `${field} is required`);
  return result;
}
function invalid(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 400 });
}
function conflict(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 409 });
}
function notFound(code: string, message: string): AppError {
  return new AppError({ code, message, statusCode: 404 });
}
function duplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11_000;
}
