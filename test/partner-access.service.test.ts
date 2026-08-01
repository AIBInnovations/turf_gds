import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

import { ObjectId } from 'mongodb';

import type { AppConfig } from '../src/config/env.js';
import type { KycService } from '../src/modules/identity/kyc/kyc.service.js';
import type { PartnerAccessRepository } from '../src/modules/identity/partner/partner-access.repository.js';
import { createPartnerAccessService } from '../src/modules/identity/partner/partner-access.service.js';
import type {
  PartnerApiKeyDocument,
  PartnerDocument,
} from '../src/modules/identity/partner/partner-access.types.js';
import { createCanonicalRequest } from '../src/shared/auth/partner-signature.js';
import { AppError } from '../src/shared/errors/app-error.js';

const fixedNow = new Date('2026-07-28T08:00:00.000Z');
const authConfig: AppConfig['auth'] = {
  sessionTtlHours: 168,
  maxSessions: 5,
  maxLoginAttempts: 5,
  lockMinutes: 15,
  adminAccessTokenSecret: 'test-admin-secret-with-at-least-32-chars',
  adminAccessTokenTtlMinutes: 60,
  partnerCredentialMasterSecret:
    'test-partner-secret-with-at-least-32-chars',
  partnerHmacMaxSkewSeconds: 300,
};

function createKycFake(verified = true): KycService {
  return {
    async createDraft() {
      throw new Error('not used');
    },
    async uploadDocument() {
      throw new Error('not used');
    },
    async updateDocumentDetails(){},
    async listDocuments(){return[];},
    async submit() {},
    async getCurrent() {
      throw new Error('not used');
    },
    async isVerified() {
      return verified;
    },
    async review() {},
  };
}

function createFixture() {
  const partner: PartnerDocument = {
    _id: new ObjectId('687f00000000000000000010'),
    legal_name: 'Booking Partner Private Limited',
    display_name: 'Booking Partner',
    kyc_status: 'PENDING',
    status: 'PENDING',
    rate_limit_tier: 'STARTER',
    sandbox_approved_at: fixedNow,
    production_approved_by: null,
    production_approved_at: null,
    audit_history: [],
    created_at: fixedNow,
    updated_at: fixedNow,
  };
  let storedKey: PartnerApiKeyDocument | undefined;
  const repository: PartnerAccessRepository = {
    async createPartner() {
      return true;
    },
    async findPartner(id) {
      return id.equals(partner._id) ? partner : null;
    },
    async approveSandbox() {
      return true;
    },
    async approveProduction() {
      return true;
    },
    async setIntegrationReviewStatus() {
      return true;
    },
    async insertApiKey(key) {
      storedKey = key;
    },
    async findApiKeyByPrefix(prefix) {
      return storedKey?.key_prefix === prefix ? storedKey : null;
    },
    async touchApiKey(_id, now) {
      if (storedKey) {
        storedKey.last_used_at = now;
      }
    },
    async revokeApiKey() {
      return true;
    },
    async recordUsage() {},
    async insertWebhook() {
      return true;
    },
    async verifyWebhook() {
      return true;
    },
    async replaceWebhookSubscriptions() {
      return true;
    },
    async disableWebhook() {
      return true;
    },
  };
  const service = createPartnerAccessService({
    repository,
    kycService: createKycFake(),
    authConfig,
    now: () => fixedNow,
  });
  return { partner, service, getStoredKey: () => storedKey };
}

test('issued Partner credentials authenticate a signed request', async () => {
  const fixture = createFixture();
  const credentials = await fixture.service.issueKey({
    partnerId: fixture.partner._id.toHexString(),
    environment: 'SANDBOX',
    scopes: ['bookings:read', 'webhooks:write'],
  });
  const timestamp = String(Math.floor(fixedNow.getTime() / 1_000));
  const body = Buffer.from('{"url":"https://example.com/webhook"}');
  const canonical = createCanonicalRequest({
    timestamp,
    method: 'POST',
    path: '/api/v1/partners/webhooks',
    body,
  });
  const signature = createHmac('sha256', credentials.signingSecret)
    .update(canonical)
    .digest('hex');
  const context = await fixture.service.authenticateRequest({
    apiKey: credentials.apiKey,
    signature: `sha256=${signature}`,
    timestamp,
    method: 'POST',
    path: '/api/v1/partners/webhooks',
    body,
  });

  assert.equal(context.partnerId, fixture.partner._id.toHexString());
  assert.equal(context.environment, 'SANDBOX');
  assert.deepEqual(context.scopes, ['bookings:read', 'webhooks:write']);
  assert.notEqual(
    fixture.getStoredKey()?.key_hash,
    credentials.apiKey,
  );
  assert.notEqual(
    fixture.getStoredKey()?.signing_secret_hash,
    credentials.signingSecret,
  );
});

test('stale Partner request timestamps are rejected', async () => {
  const fixture = createFixture();
  const credentials = await fixture.service.issueKey({
    partnerId: fixture.partner._id.toHexString(),
    environment: 'SANDBOX',
    scopes: ['bookings:read'],
  });

  await assert.rejects(
    fixture.service.authenticateRequest({
      apiKey: credentials.apiKey,
      signature: 'invalid',
      timestamp: '1',
      method: 'GET',
      path: '/api/v1/venues',
      body: Buffer.alloc(0),
    }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_PARTNER_AUTHENTICATION',
  );
});
