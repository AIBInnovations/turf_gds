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
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../../../shared/auth/password.js';
import { generateSessionToken, hashSessionToken } from '../../../shared/auth/session-token.js';
import type {
  PartnerRateLimiter,
  RateLimitDecision,
  RateLimitTier,
} from '../../../shared/rate-limit/partner-rate-limiter.js';
import {
  EXTERNAL_EVENT_TYPES,
  type ExternalEventType,
} from '../../../shared/communications/communications.types.js';
import type { KycService } from '../kyc/kyc.service.js';
import { createSecureWebhookTransport } from '../../../shared/communications/webhook-transport.js';
import type { PartnerAccessRepository } from './partner-access.repository.js';
import type { PartnerEnvironment } from './partner-access.types.js';

export interface PartnerAccessService {
  apply(input: {
    legalName: string;
    displayName: string;
    email: string;
    phoneE164: string;
    password: string;
  }): Promise<{ partnerId: string; status: 'PENDING' }>;
  login(input: { email: string; password: string }): Promise<{
    sessionToken: string;
    expiresAt: string;
    partner: { id: string; legalName: string; displayName: string; email: string; status: string };
  }>;
  authenticatePortalSession(token: string): Promise<{
    actorType: 'PARTNER_PORTAL'; partnerId: string; status: 'PENDING'|'ACTIVE';
  }>;
  logoutPortalSession(partnerId:string,token:string):Promise<void>;
  approveSandbox(input: {
    partnerId: string;
    adminId: string;
    correlationId: string;
  }): Promise<void>;
  approveProduction(input: {
    partnerId: string;
    adminId: string;
    correlationId: string;
  }): Promise<void>;
  recordIntegrationReview(input: {
    partnerId: string;
    adminId: string;
    status: 'PENDING' | 'PASSED' | 'FAILED';
    correlationId: string;
  }): Promise<void>;
  setRateLimitTier(input: {
    partnerId: string;
    adminId: string;
    correlationId: string;
    tier: RateLimitTier;
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
    nonce?: string;
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
  consumeRateLimit?(input: {
    partnerId: string;
    environment: PartnerEnvironment;
  }): Promise<RateLimitDecision>;
  registerWebhook(input: {
    partnerId: string;
    environment: PartnerEnvironment;
    url: string;
    subscribedEvents: ExternalEventType[];
  }): Promise<{
    webhookId: string;
    status: 'PENDING';
    signingSecret: string;
    subscribedEvents: ExternalEventType[];
  }>;
  listWebhooks(input:{partnerId:string;environment:PartnerEnvironment}):Promise<unknown[]>;
  rotateWebhookSecret(input:{webhookId:string;partnerId:string;environment:PartnerEnvironment}):Promise<{signingSecret:string;status:'PENDING'}>;
  testWebhook(input:{webhookId:string;partnerId:string;environment:PartnerEnvironment}):Promise<{status:'ACTIVE';responseCode:number|null}>;
  replaceWebhookSubscriptions(input: {
    webhookId: string;
    partnerId: string;
    environment: PartnerEnvironment;
    subscribedEvents: ExternalEventType[];
  }): Promise<void>;
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
  rateLimiter?: PartnerRateLimiter;
  now?: () => Date;
}): PartnerAccessService {
  const now = input.now ?? (() => new Date());

  async function apply(
    values: Parameters<PartnerAccessService['apply']>[0],
  ): ReturnType<PartnerAccessService['apply']> {
    const timestamp = now();
    const partnerId = new ObjectId();
    const email = values.email.trim().toLowerCase();
    const passwordHash = await hashPassword(values.password);
    const created = await input.repository.createPartner({
      _id: partnerId,
      legal_name: values.legalName.trim(),
      display_name: values.displayName.trim(),
      email,
      phone_e164: values.phoneE164.trim(),
      password_hash: passwordHash,
      failed_login_count: 0,
      locked_until: null,
      last_login_at: null,
      sessions: [],
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

  async function login(values: Parameters<PartnerAccessService['login']>[0]) {
    const timestamp = now();
    const partner = await input.repository.findPartnerByEmail?.(values.email.trim().toLowerCase()) ?? null;
    if (!partner) {
      await verifyPassword(values.password, DUMMY_PASSWORD_HASH);
      throw invalidPartnerCredentials();
    }
    if (partner.status === 'SUSPENDED') throw new AppError({ code: 'PARTNER_SUSPENDED', message: 'This Partner account is suspended', statusCode: 403 });
    if (partner.locked_until && partner.locked_until > timestamp) throw new AppError({ code: 'PARTNER_ACCOUNT_LOCKED', message: 'Too many failed login attempts', statusCode: 423, details: { lockedUntil: partner.locked_until.toISOString() } });
    if (!partner.password_hash || !(await verifyPassword(values.password, partner.password_hash))) {
      await input.repository.recordFailedLogin?.(partner._id, input.authConfig.maxLoginAttempts, new Date(timestamp.getTime() + input.authConfig.lockMinutes * 60_000), timestamp);
      throw invalidPartnerCredentials();
    }
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(timestamp.getTime() + input.authConfig.sessionTtlHours * 60 * 60_000);
    if (!(await input.repository.recordSuccessfulLogin?.(partner._id, hashSessionToken(sessionToken), expiresAt, timestamp))) throw invalidPartnerCredentials();
    return { sessionToken, expiresAt: expiresAt.toISOString(), partner: { id: partner._id.toHexString(), legalName: partner.legal_name, displayName: partner.display_name, email: partner.email ?? '', status: partner.status } };
  }

  async function authenticatePortalSession(token: string) {
    const partner = await input.repository.findBySessionTokenHash?.(hashSessionToken(token), now()) ?? null;
    if (!partner) throw invalidPartnerCredentials();
    return { actorType: 'PARTNER_PORTAL' as const, partnerId: partner._id.toHexString(), status: partner.status as 'PENDING'|'ACTIVE' };
  }

  async function logoutPortalSession(partnerId:string,token:string){
    if(!input.repository.revokeSession||!(await input.repository.revokeSession(toObjectId(partnerId),hashSessionToken(token),now())))throw invalidPartnerCredentials();
  }

  async function approveSandbox(
    values: Parameters<PartnerAccessService['approveSandbox']>[0],
  ): Promise<void> {
    const approved = await input.repository.approveSandbox(
      toObjectId(values.partnerId),
      toObjectId(values.adminId),
      values.correlationId,
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
      values.correlationId,
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
        toObjectId(values.adminId),
        values.status,
        values.correlationId,
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
          ...(values.nonce ? { nonce: values.nonce } : {}),
        }),
        signingSecret,
        values.signature,
      )
    ) {
      throw invalidPartnerAuthentication();
    }
    if (input.repository.claimRequestSignature && !(await input.repository.claimRequestSignature(key._id,hashCredential(`${values.timestamp}:${values.nonce ?? ''}:${values.signature}`),new Date(now().getTime()+input.authConfig.partnerHmacMaxSkewSeconds*1_000)))) {
      throw new AppError({code:'PARTNER_REQUEST_REPLAYED',message:'This signed Partner request was already used',statusCode:409});
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

  async function consumeRateLimit(
    values: {
      partnerId: string;
      environment: PartnerEnvironment;
    },
  ): Promise<RateLimitDecision> {
    const partner = await input.repository.findPartner(
      toObjectId(values.partnerId),
    );
    if (!partner) throw invalidPartnerAuthentication();
    if (!input.rateLimiter) {
      return {
        allowed: true,
        limit: Number.MAX_SAFE_INTEGER,
        remaining: Number.MAX_SAFE_INTEGER,
        resetAt: new Date(now().getTime() + 60_000),
        source: 'MONGODB',
      };
    }
    return input.rateLimiter.consume({
      partnerId: values.partnerId,
      environment: values.environment,
      tier: partner.rate_limit_tier,
      now: now(),
    });
  }

  async function setRateLimitTier(
    values: Parameters<PartnerAccessService['setRateLimitTier']>[0],
  ): Promise<void> {
    if (!input.repository.setRateLimitTier || !(await input.repository.setRateLimitTier(
      toObjectId(values.partnerId),
      values.tier,
      toObjectId(values.adminId),
      values.correlationId,
      now(),
    ))) {
      throw transitionNotAllowed();
    }
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
    const subscribedEvents = normalizeSubscriptions(values.subscribedEvents);
    const signingSecret = webhookSecret(input.authConfig.partnerCredentialMasterSecret,webhookId,1);
    const timestamp = now();
    const created = await input.repository.insertWebhook({
      _id: webhookId,
      partner_id: toObjectId(values.partnerId),
      environment: values.environment,
      url: parsedUrl.toString(),
      signing_secret_hash: hashCredential(signingSecret),
      secret_version: 1,
      subscribed_event_types: subscribedEvents,
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
      subscribedEvents,
    };
  }

  async function listWebhooks(values:Parameters<PartnerAccessService['listWebhooks']>[0]){
    const rows=await input.repository.listWebhooks?.(toObjectId(values.partnerId),values.environment)??[];
    return rows.map(v=>({webhookId:v._id.toHexString(),url:v.url,environment:v.environment,subscribedEvents:v.subscribed_event_types,status:v.status,verifiedAt:v.verified_at?.toISOString()??null,secretVersion:v.secret_version??1,createdAt:v.created_at.toISOString(),updatedAt:v.updated_at.toISOString()}));
  }

  async function rotateWebhookSecret(values:Parameters<PartnerAccessService['rotateWebhookSecret']>[0]){
    const id=toObjectId(values.webhookId);const endpoint=await input.repository.findWebhook?.(id,toObjectId(values.partnerId),values.environment);
    if(!endpoint)throw transitionNotAllowed();const version=(endpoint.secret_version??1)+1;const signingSecret=webhookSecret(input.authConfig.partnerCredentialMasterSecret,id,version);
    if(!(await input.repository.rotateWebhookSecret?.(id,endpoint.partner_id,values.environment,hashCredential(signingSecret),version,now())))throw transitionNotAllowed();
    return{signingSecret,status:'PENDING' as const};
  }

  async function testWebhook(values:Parameters<PartnerAccessService['testWebhook']>[0]){
    const id=toObjectId(values.webhookId);const endpoint=await input.repository.findWebhook?.(id,toObjectId(values.partnerId),values.environment);if(!endpoint||endpoint.status==='DISABLED')throw transitionNotAllowed();
    const secret=webhookSecret(input.authConfig.partnerCredentialMasterSecret,id,endpoint.secret_version??1);if(hashCredential(secret)!==endpoint.signing_secret_hash)throw transitionNotAllowed();
    const result=await createSecureWebhookTransport().deliver({url:endpoint.url,secret,eventId:new ObjectId().toHexString(),eventType:'webhook.test',body:JSON.stringify({eventType:'webhook.test',webhookId:values.webhookId,environment:values.environment}),timeoutMs:10_000,now:now()});
    if(!result.delivered)throw new AppError({code:'WEBHOOK_TEST_FAILED',message:'The webhook endpoint did not accept the signed test event',statusCode:424,details:{responseCode:result.attempt.response_code,error:result.attempt.error}});
    await verifyWebhook(values.webhookId);return{status:'ACTIVE' as const,responseCode:result.attempt.response_code};
  }

  async function replaceWebhookSubscriptions(
    values: Parameters<
      PartnerAccessService['replaceWebhookSubscriptions']
    >[0],
  ): Promise<void> {
    const subscribedEvents = normalizeSubscriptions(values.subscribedEvents);
    if (
      !(await input.repository.replaceWebhookSubscriptions(
        toObjectId(values.webhookId),
        toObjectId(values.partnerId),
        values.environment,
        subscribedEvents,
        now(),
      ))
    ) {
      throw transitionNotAllowed();
    }
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
    login,
    authenticatePortalSession,
    logoutPortalSession,
    approveSandbox,
    approveProduction,
    recordIntegrationReview,
    setRateLimitTier,
    issueKey,
    authenticateRequest,
    revokeKey,
    recordApiUsage,
    consumeRateLimit,
    registerWebhook,
    listWebhooks,
    rotateWebhookSecret,
    testWebhook,
    replaceWebhookSubscriptions,
    verifyWebhook,
    disableWebhook,
  };
}

function invalidPartnerCredentials(): AppError {
  return new AppError({ code: 'INVALID_PARTNER_CREDENTIALS', message: 'The Partner credentials are invalid', statusCode: 401 });
}
function webhookSecret(master:string,id:ObjectId,version:number){return deriveSigningSecret(master,version===1?`webhook:${id.toHexString()}`:`webhook:${id.toHexString()}:v${version}`);}

function normalizeSubscriptions(values: readonly string[]): ExternalEventType[] {
  const unique = [...new Set(values.map((value) => value.trim().toLowerCase()))];
  if (
    unique.length === 0 ||
    unique.length > 20 ||
    unique.some(
      (value) =>
        !EXTERNAL_EVENT_TYPES.includes(value as ExternalEventType),
    )
  ) {
    throw new AppError({
      code: 'INVALID_WEBHOOK_SUBSCRIPTIONS',
      message: 'Webhook subscriptions contain unsupported event types',
      statusCode: 400,
    });
  }
  return unique as ExternalEventType[];
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
