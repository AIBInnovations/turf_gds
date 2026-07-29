import { ObjectId } from 'mongodb';

import type { AppConfig } from '../../../config/env.js';
import {
  createCanonicalRequest,
  createPartnerApiKey,
  deriveSigningSecret,
  extractKeyPrefix,
  hashCredential,
  verifyHmacSignature,
} from '../../../shared/auth/partner-signature.js';
import { AppError } from '../../../shared/errors/app-error.js';
import type { KycService } from '../kyc/kyc.service.js';
import type { PartnerAccessRepository } from './partner-access.repository.js';
import type { PartnerEnvironment } from './partner-access.types.js';

export interface PartnerAccessService {
  apply(input: {
    legalName: string;
    displayName: string;
    email: string;
  }): Promise<{ partnerId: string; status: 'PENDING' }>;
  approveSandbox(input: {
    partnerId: string;
    adminId: string;
  }): Promise<void>;
  approveProduction(input: {
    partnerId: string;
    adminId: string;
  }): Promise<void>;
  recordIntegrationReview(input: {
    partnerId: string;
    status: 'PENDING' | 'PASSED' | 'FAILED';
  }): Promise<void>;
  issueKey(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    scopes: string[];
    expiresAt?: string;
  }): Promise<{
    keyId: string;
    apiKey: string;
    signingSecret: string;
    environment: PartnerEnvironment;
    scopes: string[];
  }>;
  authenticateRequest(input: {
    apiKey: string;
    signature: string;
    timestamp: string;
    method: string;
    path: string;
    body: Buffer;
  }): Promise<{
    actorType: 'PARTNER';
    partnerId: string;
    keyId: string;
    environment: PartnerEnvironment;
    scopes: string[];
  }>;
  revokeKey(keyId: string): Promise<void>;
  recordApiUsage(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    statusCode: number;
    latencyMs: number;
    rateLimited?: boolean;
  }): Promise<void>;
  registerWebhook(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    url: string;
    subscribedEvents: string[];
  }): Promise<{
    webhookId: string;
    status: 'PENDING';
    signingSecret: string;
  }>;
  verifyWebhook(webhookId: string): Promise<void>;
  disableWebhook(input: {
    webhookId: string;
    partnerId: string;
    environment: PartnerEnvironment;
  }): Promise<void>;
}

export function createPartnerAccessService(input: {
  repository: PartnerAccessRepository;
  kycService: KycService;
  authConfig: AppConfig['auth'];
  now?: () => Date;
}): PartnerAccessService {
  const now = input.now ?? (() => new Date());

  async function apply(
    values: Parameters<PartnerAccessService['apply']>[0],
  ): ReturnType<PartnerAccessService['apply']> {
    const timestamp = now();
    const partnerId = new ObjectId();
    const created = await input.repository.createPartner({
      _id: partnerId,
      legal_name: values.legalName.trim(),
      display_name: values.displayName.trim(),
      kyc_status: 'PENDING',
      status: 'PENDING',
      rate_limit_tier: 'STARTER',
      sandbox_approved_at: null,
      production_approved_by: null,
      production_approved_at: null,
      audit_history: [],
      created_at: timestamp,
      updated_at: timestamp,
    });

    if (!created) {
      throw new AppError({
        code: 'PARTNER_ALREADY_EXISTS',
        message: 'A matching Partner application already exists',
        statusCode: 409,
      });
    }
    return { partnerId: partnerId.toHexString(), status: 'PENDING' };
  }

  async function approveSandbox(
    values: Parameters<PartnerAccessService['approveSandbox']>[0],
  ): Promise<void> {
    const approved = await input.repository.approveSandbox(
      toObjectId(values.partnerId),
      toObjectId(values.adminId),
      now(),
    );
    if (!approved) {
      throw transitionNotAllowed();
    }
  }

  async function approveProduction(
    values: Parameters<PartnerAccessService['approveProduction']>[0],
  ): Promise<void> {
    if (
      !(await input.kycService.isVerified(
        'PARTNER',
        values.partnerId,
        'BUSINESS',
      ))
    ) {
      throw new AppError({
        code: 'PARTNER_KYC_REQUIRED',
        message: 'Verified BUSINESS KYC is required',
        statusCode: 409,
      });
    }

    const approved = await input.repository.approveProduction(
      toObjectId(values.partnerId),
      toObjectId(values.adminId),
      now(),
    );
    if (!approved) {
      throw transitionNotAllowed();
    }
  }

  async function issueKey(
    values: Parameters<PartnerAccessService['issueKey']>[0],
  ): ReturnType<PartnerAccessService['issueKey']> {
    const partnerId = toObjectId(values.partnerId);
    const partner = await input.repository.findPartner(partnerId);

    if (
      !partner ||
      partner.status === 'SUSPENDED' ||
      (values.environment === 'SANDBOX' &&
        !partner.sandbox_approved_at) ||
      (values.environment === 'PRODUCTION' &&
        (partner.status !== 'ACTIVE' ||
          !partner.production_approved_at))
    ) {
      throw new AppError({
        code: 'KEY_ISSUANCE_NOT_ALLOWED',
        message: 'The Partner is not approved for this environment',
        statusCode: 409,
      });
    }

    if (
      values.environment === 'PRODUCTION' &&
      !(await input.kycService.isVerified(
        'PARTNER',
        values.partnerId,
        'BUSINESS',
      ))
    ) {
      throw new AppError({
        code: 'PARTNER_KYC_REQUIRED',
        message: 'Verified BUSINESS KYC is required',
        statusCode: 409,
      });
    }

    const keyId = new ObjectId();
    const generated = createPartnerApiKey(values.environment);
    const signingSecret = deriveSigningSecret(
      input.authConfig.partnerCredentialMasterSecret,
      `partner-key:${keyId.toHexString()}:${generated.prefix}`,
    );
    const scopes = [...new Set(values.scopes.map(normalizeScope))].sort();
    await input.repository.insertApiKey({
      _id: keyId,
      partner_id: partnerId,
      environment: values.environment,
      key_prefix: generated.prefix,
      key_hash: hashCredential(generated.apiKey),
      signing_secret_hash: hashCredential(signingSecret),
      scopes: { values: scopes },
      status: 'ACTIVE',
      last_used_at: null,
      expires_at: values.expiresAt ? new Date(values.expiresAt) : null,
      created_at: now(),
      revoked_at: null,
    });

    return {
      keyId: keyId.toHexString(),
      apiKey: generated.apiKey,
      signingSecret,
      environment: values.environment,
      scopes,
    };
  }

  async function recordIntegrationReview(
    values: Parameters<
      PartnerAccessService['recordIntegrationReview']
    >[0],
  ): Promise<void> {
    if (
      !(await input.repository.setIntegrationReviewStatus(
        toObjectId(values.partnerId),
        values.status,
        now(),
      ))
    ) {
      throw transitionNotAllowed();
    }
  }

  async function authenticateRequest(
    values: Parameters<PartnerAccessService['authenticateRequest']>[0],
  ): ReturnType<PartnerAccessService['authenticateRequest']> {
    const prefix = extractKeyPrefix(values.apiKey);
    const timestampSeconds = Number(values.timestamp);
    const currentSeconds = Math.floor(now().getTime() / 1_000);

    if (
      !prefix ||
      !Number.isInteger(timestampSeconds) ||
      Math.abs(currentSeconds - timestampSeconds) >
        input.authConfig.partnerHmacMaxSkewSeconds
    ) {
      throw invalidPartnerAuthentication();
    }

    const key = await input.repository.findApiKeyByPrefix(prefix);

    if (
      !key ||
      key.status !== 'ACTIVE' ||
      (key.expires_at && key.expires_at <= now()) ||
      hashCredential(values.apiKey) !== key.key_hash
    ) {
      throw invalidPartnerAuthentication();
    }

    const signingSecret = deriveSigningSecret(
      input.authConfig.partnerCredentialMasterSecret,
      `partner-key:${key._id.toHexString()}:${key.key_prefix}`,
    );

    if (
      hashCredential(signingSecret) !== key.signing_secret_hash ||
      !verifyHmacSignature(
        createCanonicalRequest({
          timestamp: values.timestamp,
          method: values.method,
          path: values.path,
          body: values.body,
        }),
        signingSecret,
        values.signature,
      )
    ) {
      throw invalidPartnerAuthentication();
    }

    const partner = await input.repository.findPartner(key.partner_id);

    if (
      !partner ||
      partner.status === 'SUSPENDED' ||
      (key.environment === 'PRODUCTION' && partner.status !== 'ACTIVE')
    ) {
      throw invalidPartnerAuthentication();
    }

    await input.repository.touchApiKey(key._id, now());
    return {
      actorType: 'PARTNER',
      partnerId: key.partner_id.toHexString(),
      keyId: key._id.toHexString(),
      environment: key.environment,
      scopes: key.scopes.values,
    };
  }

  async function revokeKey(keyId: string): Promise<void> {
    if (!(await input.repository.revokeApiKey(toObjectId(keyId), now()))) {
      throw transitionNotAllowed();
    }
  }

  async function recordApiUsage(
    values: Parameters<PartnerAccessService['recordApiUsage']>[0],
  ): Promise<void> {
    await input.repository.recordUsage({
      partnerId: toObjectId(values.partnerId),
      environment: values.environment,
      statusCode: values.statusCode,
      latencyMs: values.latencyMs,
      rateLimited: values.rateLimited ?? false,
      now: now(),
    });
  }

  async function registerWebhook(
    values: Parameters<PartnerAccessService['registerWebhook']>[0],
  ): ReturnType<PartnerAccessService['registerWebhook']> {
    const parsedUrl = new URL(values.url);

    if (parsedUrl.protocol !== 'https:') {
      throw new AppError({
        code: 'HTTPS_WEBHOOK_REQUIRED',
        message: 'Webhook URLs must use HTTPS',
        statusCode: 400,
      });
    }

    const webhookId = new ObjectId();
    const signingSecret = deriveSigningSecret(
      input.authConfig.partnerCredentialMasterSecret,
      `webhook:${webhookId.toHexString()}`,
    );
    const timestamp = now();
    const created = await input.repository.insertWebhook({
      _id: webhookId,
      partner_id: toObjectId(values.partnerId),
      environment: values.environment,
      url: parsedUrl.toString(),
      signing_secret_hash: hashCredential(signingSecret),
      status: 'PENDING',
      verified_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    });

    if (!created) {
      throw new AppError({
        code: 'WEBHOOK_ALREADY_EXISTS',
        message: 'This webhook URL is already configured',
        statusCode: 409,
      });
    }

    return {
      webhookId: webhookId.toHexString(),
      status: 'PENDING',
      signingSecret,
    };
  }

  async function verifyWebhook(webhookId: string): Promise<void> {
    if (
      !(await input.repository.verifyWebhook(
        toObjectId(webhookId),
        now(),
      ))
    ) {
      throw transitionNotAllowed();
    }
  }

  async function disableWebhook(
    values: Parameters<PartnerAccessService['disableWebhook']>[0],
  ): Promise<void> {
    if (
      !(await input.repository.disableWebhook(
        toObjectId(values.webhookId),
        toObjectId(values.partnerId),
        values.environment,
        now(),
      ))
    ) {
      throw transitionNotAllowed();
    }
  }

  return {
    apply,
    approveSandbox,
    approveProduction,
    recordIntegrationReview,
    issueKey,
    authenticateRequest,
    revokeKey,
    recordApiUsage,
    registerWebhook,
    verifyWebhook,
    disableWebhook,
  };
}

function normalizeScope(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '');
}

function toObjectId(value: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: 'INVALID_ID',
      message: 'A supplied identifier is invalid',
      statusCode: 400,
    });
  }
  return new ObjectId(value);
}

function invalidPartnerAuthentication(): AppError {
  return new AppError({
    code: 'INVALID_PARTNER_AUTHENTICATION',
    message: 'Partner API authentication failed',
    statusCode: 401,
  });
}

function transitionNotAllowed(): AppError {
  return new AppError({
    code: 'TRANSITION_NOT_ALLOWED',
    message: 'The requested state transition is not allowed',
    statusCode: 409,
  });
}
