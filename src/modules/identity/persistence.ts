import type { Db, Document } from 'mongodb';

import { ObjectId } from 'mongodb';

import {
  PERMISSIONS,
  type VenueMembershipRole,
  type VenuePermission,
} from './owner/owner.types.js';
import { EXTERNAL_EVENT_TYPES } from '../../shared/communications/communications.types.js';

const fcmTokenSchema: Document = {
  bsonType: 'object',
  additionalProperties: false,
  required: ['token', 'device_id', 'platform', 'last_seen_at', 'created_at'],
  properties: {
    token: { bsonType: 'string', minLength: 20, maxLength: 4_096 },
    device_id: { bsonType: 'string', minLength: 1, maxLength: 200 },
    platform: { enum: ['ANDROID', 'IOS', 'WEB'] },
    last_seen_at: { bsonType: 'date' },
    created_at: { bsonType: 'date' },
  },
};

const ownerNotificationSchema: Document = {
  bsonType: 'object',
  additionalProperties: false,
  required: [
    'notification_type', 'aggregate_type', 'aggregate_id', 'venue_id',
    'payload', 'read_at', 'created_at',
  ],
  properties: {
    notification_type: {
      enum: [
        'BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'PAYOUT_PENDING',
        'PAYOUT_COMPLETED', 'PAYOUT_FAILED', 'SETTLEMENT_CREATED',
        'SETTLEMENT_COMPLETED', 'CONTRACT_PROPOSED', 'CONTRACT_ACCEPTED',
        'KYC_SUBMITTED', 'KYC_VERIFIED', 'KYC_REJECTED',
        'PAYMENT_RECORDED', 'PAYMENT_REFUNDED', 'VENUE_UPDATED',
        'COURT_UPDATED', 'AVAILABILITY_CHANGED',
      ],
    },
    aggregate_type: { enum: ['BOOKING','PAYMENT','SETTLEMENT','PAYOUT','CONTRACT','KYC','VENUE','COURT','INVENTORY'] },
    aggregate_id: { bsonType: 'objectId' },
    venue_id: { bsonType: 'objectId' },
    payload: { bsonType: 'object' },
    read_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
  },
};

function documentValidator(
  required: string[],
  properties: Document,
): Document {
  return {
    $jsonSchema: {
      bsonType: 'object',
      additionalProperties: false,
      required: ['_id', ...required],
      properties: {
        _id: { bsonType: 'objectId' },
        ...properties,
      },
    },
  };
}

const adminValidator = documentValidator(
  [
    'email',
    'password_hash',
    'display_name',
    'role',
    'status',
    'fcm_tokens',
    'audit_history',
    'last_login_at',
    'created_at',
    'updated_at',
  ],
  {
    email: { bsonType: 'string' },
    password_hash: { bsonType: 'string' },
    display_name: { bsonType: 'string' },
    role: { enum: ['ADMIN', 'OPS', 'SUPPORT'] },
    status: { enum: ['ACTIVE', 'DISABLED'] },
    fcm_tokens: {
      bsonType: 'array',
      maxItems: 20,
      items: fcmTokenSchema,
    },
    audit_history: { bsonType: 'array', maxItems: 100 },
    last_login_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const permissionValidator = documentValidator(
  ['role', 'permission', 'created_at'],
  {
    role: { enum: ['OWNER', 'MANAGER', 'STAFF'] },
    permission: { enum: [...PERMISSIONS] },
    created_at: { bsonType: 'date' },
  },
);

const kycVerificationValidator = documentValidator(
  [
    'subject_type',
    'subject_id',
    'verification_type',
    'status',
    'is_current',
    'reviewed_by',
    'preliminary_reviewed_by','preliminary_reviewed_at','preliminary_status','preliminary_checklist','preliminary_notes',
    'reviewed_at',
    'rejection_reason',
    'expires_at',
    'created_at',
    'audit_history',
  ],
  {
    subject_type: { enum: ['VENUE_OWNER', 'PARTNER'] },
    subject_id: { bsonType: 'objectId' },
    verification_type: { enum: ['IDENTITY', 'BUSINESS', 'ADDRESS'] },
    status: { enum: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] },
    is_current: { bsonType: 'bool' },
    reviewed_by: { bsonType: ['objectId', 'null'] },
    preliminary_reviewed_by:{bsonType:['objectId','null']},preliminary_reviewed_at:{bsonType:['date','null']},preliminary_status:{enum:['APPROVED','REJECTED',null]},preliminary_checklist:{bsonType:['object','null']},preliminary_notes:{bsonType:['string','null']},
    reviewed_at: { bsonType: ['date', 'null'] },
    rejection_reason: { bsonType: ['string', 'null'] },
    expires_at: { bsonType: ['date', 'null'] },
    audit_history: { bsonType: 'array', maxItems: 100 },
    created_at: { bsonType: 'date' },
  },
);

const kycDocumentValidator = documentValidator(
  [
    'kyc_verification_id',
    'file',
    'document_type',
    'status',
    'rejection_reason',
    'created_at',
  ],
  {
    kyc_verification_id: { bsonType: 'objectId' },
    document_type: {
      enum: [
        'PAN', 'AADHAAR', 'GST_CERTIFICATE', 'PASSBOOK', 'BUSINESS_REGISTRATION',
        'ADDRESS_PROOF', 'ID_PROOF',
      ],
    },
    file: {
      bsonType: 'object',
      additionalProperties: false,
      required: [
        'storage_key', 'mime_type', 'size_bytes', 'checksum',
        'classification', 'status', 'created_at',
      ],
      properties: {
        storage_key: { bsonType: 'string' },
        mime_type: { bsonType: 'string' },
        size_bytes: { bsonType: ['int', 'long'], minimum: 0 },
        checksum: { bsonType: 'string' },
        classification: { enum: ['SENSITIVE'] },
        status: { enum: ['ACTIVE', 'DELETED'] },
        created_at: { bsonType: 'date' },
      },
    },
    details: { bsonType: 'object' },
    status: { enum: ['PENDING', 'ACCEPTED', 'REJECTED'] },
    rejection_reason: { bsonType: ['string', 'null'] },
    created_at: { bsonType: 'date' },
  },
);

const partnerValidator = documentValidator(
  [
    'legal_name',
    'display_name',
    'kyc_status',
    'status',
    'rate_limit_tier',
    'sandbox_approved_at',
    'production_approved_by',
    'production_approved_at',
    'audit_history',
    'created_at',
    'updated_at',
  ],
  {
    legal_name: { bsonType: 'string' },
    display_name: { bsonType: 'string' },
    email: { bsonType: 'string' },
    phone_e164: { bsonType: 'string' },
    password_hash: { bsonType: 'string' },
    failed_login_count: { bsonType: 'int', minimum: 0 },
    locked_until: { bsonType: ['date', 'null'] },
    last_login_at: { bsonType: ['date', 'null'] },
    sessions: { bsonType: 'array', maxItems: 10 },
    kyc_status: { enum: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] },
    status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
    rate_limit_tier: { enum: ['STARTER', 'STANDARD', 'ENTERPRISE'] },
    sandbox_approved_at: { bsonType: ['date', 'null'] },
    production_approved_by: { bsonType: ['objectId', 'null'] },
    production_approved_at: { bsonType: ['date', 'null'] },
    audit_history: { bsonType: 'array', maxItems: 100 },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const partnerKeyValidator = documentValidator(
  [
    'partner_id',
    'environment',
    'key_prefix',
    'key_hash',
    'signing_secret_hash',
    'scopes',
    'status',
    'last_used_at',
    'expires_at',
    'created_at',
    'revoked_at',
  ],
  {
    partner_id: { bsonType: 'objectId' },
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    key_prefix: { bsonType: 'string' },
    key_hash: { bsonType: 'string' },
    signing_secret_hash: { bsonType: 'string' },
    scopes: { bsonType: 'object' },
    status: { enum: ['ACTIVE', 'REVOKED', 'EXPIRED'] },
    last_used_at: { bsonType: ['date', 'null'] },
    expires_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
    revoked_at: { bsonType: ['date', 'null'] },
  },
);

const partnerPayoutAccountValidator = documentValidator(
  ['partner_id','label','account_holder_name','bank_name','ifsc_code','account_last4','account_vault_token','status','is_default','failure_reason','documents','version','created_at','updated_at'],
  {
    partner_id:{bsonType:'objectId'},label:{bsonType:'string'},account_holder_name:{bsonType:'string'},bank_name:{bsonType:'string'},ifsc_code:{bsonType:'string'},account_last4:{bsonType:'string'},account_vault_token:{bsonType:'string'},status:{enum:['PENDING','VERIFIED','FAILED','DISABLED']},is_default:{bsonType:'bool'},failure_reason:{bsonType:['string','null']},documents:{bsonType:'array'},version:{bsonType:'int',minimum:1},created_at:{bsonType:'date'},updated_at:{bsonType:'date'},
  },
);

const usageValidator = documentValidator(
  [
    'partner_id',
    'environment',
    'usage_date',
    'request_count',
    'error_count',
    'rate_limited_count',
    'p95_latency_ms',
    'rate_limit_window_started_at',
    'rate_limit_window_count',
    'updated_at',
  ],
  {
    partner_id: { bsonType: 'objectId' },
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    usage_date: { bsonType: 'date' },
    request_count: { bsonType: ['int', 'long'] },
    error_count: { bsonType: ['int', 'long'] },
    rate_limited_count: { bsonType: ['int', 'long'] },
    p95_latency_ms: { bsonType: ['int', 'long'] },
    latency_samples: { bsonType: 'array', maxItems: 500, items: { bsonType: ['int', 'long'] } },
    rate_limit_window_started_at: { bsonType: 'date' },
    rate_limit_window_count: { bsonType: ['int', 'long'] },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const webhookValidator = documentValidator(
  [
    'partner_id',
    'environment',
    'url',
    'signing_secret_hash',
    'subscribed_event_types',
    'status',
    'verified_at',
    'created_at',
    'updated_at',
  ],
  {
    partner_id: { bsonType: 'objectId' },
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    url: { bsonType: 'string' },
    signing_secret_hash: { bsonType: 'string' },
    secret_version: { bsonType: 'int', minimum: 1 },
    subscribed_event_types: {
      bsonType: 'array',
      minItems: 1,
      maxItems: 20,
      uniqueItems: true,
      items: { enum: [...EXTERNAL_EVENT_TYPES] },
    },
    status: { enum: ['PENDING', 'ACTIVE', 'DISABLED'] },
    verified_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const ownerValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'legal_name',
      'email',
      'phone_e164',
      'password_hash',
      'email_verified_at',
      'kyc_status',
      'status',
      'failed_login_count',
      'locked_until',
      'last_login_at',
      'sessions',
      'fcm_tokens',
      'notifications',
      'audit_history',
      'approved_by',
      'approved_at',
      'created_at',
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      legal_name: { bsonType: 'string', minLength: 2, maxLength: 200 },
      email: { bsonType: 'string', minLength: 3, maxLength: 320 },
      phone_e164: { bsonType: 'string', minLength: 8, maxLength: 16 },
      password_hash: { bsonType: 'string' },
      email_verified_at: { bsonType: ['date', 'null'] },
      kyc_status: { enum: ['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED'] },
      status: { enum: ['ACTIVE', 'SUSPENDED'] },
      failed_login_count: { bsonType: 'int', minimum: 0 },
      locked_until: { bsonType: ['date', 'null'] },
      last_login_at: { bsonType: ['date', 'null'] },
      sessions: {
        bsonType: 'array',
        maxItems: 20,
        items: {
          bsonType: 'object',
          additionalProperties: false,
          required: [
            'token_hash',
            'ip_hash',
            'user_agent',
            'expires_at',
            'last_seen_at',
            'revoked_at',
            'created_at',
          ],
          properties: {
            token_hash: { bsonType: 'string' },
            ip_hash: { bsonType: 'string' },
            user_agent: { bsonType: 'string' },
            expires_at: { bsonType: 'date' },
            last_seen_at: { bsonType: 'date' },
            revoked_at: { bsonType: ['date', 'null'] },
            created_at: { bsonType: 'date' },
          },
        },
      },
      fcm_tokens: {
        bsonType: 'array',
        maxItems: 20,
        items: fcmTokenSchema,
      },
      notifications: {
        bsonType: 'array',
        maxItems: 100,
        items: ownerNotificationSchema,
      },
      audit_history: { bsonType: 'array', maxItems: 100 },
      approved_by: { bsonType: ['objectId', 'null'] },
      approved_at: { bsonType: ['date', 'null'] },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
    },
  },
};

const membershipValidator: Document = {
  $jsonSchema: {
    bsonType: 'object',
    additionalProperties: false,
    required: [
      '_id',
      'owner_id',
      'venue_id',
      'role',
      'status',
      'created_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      owner_id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      role: { enum: ['OWNER', 'MANAGER', 'STAFF'] },
      status: { enum: ['ACTIVE', 'REVOKED'] },
      created_at: { bsonType: 'date' },
    },
  },
};

async function ensureValidatedCollection(
  db: Db,
  name: string,
  validator: Document,
): Promise<void> {
  const exists = await db
    .listCollections({ name }, { nameOnly: true })
    .hasNext();

  if (!exists) {
    await db.createCollection(name, {
      validator,
      validationLevel: 'strict',
      validationAction: 'error',
    });
    return;
  }

  await db.command({
    collMod: name,
    validator,
    validationLevel: 'strict',
    validationAction: 'error',
  });
}

export async function initializeIdentityPersistence(db: Db): Promise<void> {
  if(await db.listCollections({name:'kyc_verifications'},{nameOnly:true}).hasNext()){
    await db.command({collMod:'kyc_verifications',validationLevel:'off'});
    await db.collection('kyc_verifications').updateMany({preliminary_reviewed_by:{$exists:false}},{$set:{preliminary_reviewed_by:null,preliminary_reviewed_at:null,preliminary_status:null,preliminary_checklist:null,preliminary_notes:null}});
  }
  if (
    await db
      .listCollections({ name: 'api_usage_daily' }, { nameOnly: true })
      .hasNext()
  ) {
    await db.command({ collMod: 'api_usage_daily', validationLevel: 'off' });
    await db.collection('api_usage_daily').updateMany(
      { rate_limit_window_started_at: { $exists: false } },
      {
        $set: {
          rate_limit_window_started_at: new Date(0),
          rate_limit_window_count: 0,
        },
      },
    );
  }
  await migrateCommunicationsEmbeds(db);
  await ensureValidatedCollection(db, 'admin_users', adminValidator);
  await ensureValidatedCollection(db,'admin_revoked_tokens',documentValidator(['jti','admin_id','expires_at','created_at'],{jti:{bsonType:'string'},admin_id:{bsonType:'objectId'},expires_at:{bsonType:'date'},created_at:{bsonType:'date'}}));
  await db.collection('admin_revoked_tokens').createIndex({jti:1},{unique:true,name:'uq_admin_revoked_token'});
  await db.collection('admin_revoked_tokens').createIndex({expires_at:1},{expireAfterSeconds:0,name:'ttl_admin_revoked_token'});
  await ensureValidatedCollection(db, 'venue_owners', ownerValidator);
  await ensureValidatedCollection(
    db,
    'venue_owner_memberships',
    membershipValidator,
  );
  await ensureValidatedCollection(
    db,
    'venue_role_permissions',
    permissionValidator,
  );
  await ensureValidatedCollection(
    db,
    'kyc_verifications',
    kycVerificationValidator,
  );
  await ensureValidatedCollection(
    db,
    'kyc_documents',
    kycDocumentValidator,
  );
  await ensureValidatedCollection(db, 'partners', partnerValidator);
  await ensureValidatedCollection(
    db,
    'partner_api_keys',
    partnerKeyValidator,
  );
  await ensureValidatedCollection(db,'partner_payout_accounts',partnerPayoutAccountValidator);
  await ensureValidatedCollection(
    db,
    'api_usage_daily',
    usageValidator,
  );
  await ensureValidatedCollection(
    db,
    'webhook_endpoints',
    webhookValidator,
  );

  await Promise.all(
    ['admin_users', 'venue_owners', 'kyc_verifications', 'partners'].map(
      (name) =>
        db.collection(name).updateMany(
          { 'audit_history.100': { $exists: true } },
          [{
            $set: {
              audit_history: { $slice: ['$audit_history', -100] },
            },
          }],
        ),
    ),
  );

  await db.collection('admin_users').createIndex(
    { email: 1 },
    { unique: true, name: 'uq_admin_users_email' },
  );
  await db.collection('venue_owners').createIndex(
    { email: 1 },
    {
      unique: true,
      name: 'uq_venue_owners_email',
    },
  );
  await db.collection('venue_owners').createIndex(
    { 'sessions.token_hash': 1 },
    {
      unique: true,
      name: 'ix_venue_owners_session_token_hash',
      sparse: true,
    },
  );
  await db.collection('admin_users').createIndex(
    { 'fcm_tokens.token': 1 },
    {
      unique: true,
      sparse: true,
      name: 'uq_admin_fcm_token',
    },
  );
  await db.collection('venue_owners').createIndex(
    { 'fcm_tokens.token': 1 },
    {
      unique: true,
      sparse: true,
      name: 'uq_owner_fcm_token',
    },
  );
  await db.collection('venue_owner_memberships').createIndex(
    { owner_id: 1, venue_id: 1 },
    {
      unique: true,
      name: 'uq_memberships_owner_venue',
    },
  );
  await db.collection('venue_role_permissions').createIndex(
    { role: 1, permission: 1 },
    { unique: true, name: 'uq_role_permissions' },
  );
  await db.collection('kyc_verifications').createIndex(
    { subject_type: 1, subject_id: 1, verification_type: 1 },
    {
      unique: true,
      partialFilterExpression: { is_current: true },
      name: 'uq_current_kyc',
    },
  );
  await db.collection('kyc_documents').createIndex(
    { kyc_verification_id: 1, status: 1 },
    { name: 'ix_kyc_documents_verification_status' },
  );
  await db.collection('kyc_documents').createIndex(
    { 'file.storage_key': 1 },
    { unique: true, name: 'uq_kyc_document_storage_key' },
  );
  await db.collection('kyc_documents').createIndex(
    {
      kyc_verification_id: 1,
      document_type: 1,
      'file.checksum': 1,
    },
    { unique: true, name: 'uq_kyc_document_checksum' },
  );
  await db.collection('partners').createIndex(
    { legal_name: 1 },
    {
      unique: true,
      name: 'uq_partners_legal_name',
      collation: { locale: 'en', strength: 2 },
    },
  );
  await db.collection('partners').createIndex(
    { email: 1 },
    { unique: true, sparse: true, name: 'uq_partners_email', collation: { locale: 'en', strength: 2 } },
  );
  await db.collection('partner_api_keys').createIndex(
    { key_prefix: 1 },
    { unique: true, name: 'uq_partner_keys_prefix' },
  );
  await db.collection('partner_auth_replays').createIndex({key_id:1,signature_hash:1},{unique:true,name:'uq_partner_auth_replay'});
  await db.collection('partner_auth_replays').createIndex({expires_at:1},{expireAfterSeconds:0,name:'ttl_partner_auth_replay'});
  await db.collection('partner_payout_accounts').createIndex({partner_id:1,status:1,created_at:-1},{name:'ix_partner_payout_accounts'});
  await db.collection('partner_payout_accounts').createIndex({partner_id:1,is_default:1},{unique:true,partialFilterExpression:{is_default:true},name:'uq_partner_default_payout_account'});
  await db.collection('api_usage_daily').createIndex(
    { partner_id: 1, environment: 1, usage_date: 1 },
    { unique: true, name: 'uq_partner_usage_daily' },
  );
  await db.collection('webhook_endpoints').createIndex(
    { partner_id: 1, environment: 1, url: 1 },
    { unique: true, name: 'uq_partner_webhook_url' },
  );

  await seedRolePermissions(db);
}

async function migrateCommunicationsEmbeds(db: Db): Promise<void> {
  const existing = new Set(
    (
      await db
        .listCollections(
          { name: { $in: ['admin_users', 'venue_owners', 'webhook_endpoints'] } },
          { nameOnly: true },
        )
        .toArray()
    ).map(({ name }) => name),
  );
  if (existing.has('admin_users')) {
    await db.collection('admin_users').updateMany(
      {},
      [{
        $set: {
          fcm_tokens: { $slice: [{ $ifNull: ['$fcm_tokens', []] }, -20] },
        },
      }],
      { bypassDocumentValidation: true },
    );
  }
  if (existing.has('venue_owners')) {
    await db.collection('venue_owners').updateMany(
      {},
      [{
        $set: {
          fcm_tokens: { $slice: [{ $ifNull: ['$fcm_tokens', []] }, -20] },
          notifications: {
            $slice: [{ $ifNull: ['$notifications', []] }, -100],
          },
        },
      }],
      { bypassDocumentValidation: true },
    );
  }
  if (existing.has('webhook_endpoints')) {
    await db.collection('webhook_endpoints').updateMany(
      { subscribed_event_types: { $exists: false } },
      { $set: { subscribed_event_types: [...EXTERNAL_EVENT_TYPES] } },
      { bypassDocumentValidation: true },
    );
  }
}

const rolePermissions: Record<VenueMembershipRole, VenuePermission[]> = {
  OWNER: [...PERMISSIONS],
  MANAGER: [
    'MANAGE_VENUE',
    'MANAGE_COURTS',
    'MANAGE_PRICING',
    'MANAGE_MEMBERS',
    'VIEW_BOOKINGS',
    'MANAGE_AVAILABILITY',
  ],
  STAFF: ['VIEW_BOOKINGS', 'MANAGE_AVAILABILITY'],
};

async function seedRolePermissions(db: Db): Promise<void> {
  const now = new Date();
  const operations = Object.entries(rolePermissions).flatMap(
    ([role, permissions]) =>
      permissions.map((permission) => ({
        updateOne: {
          filter: { role, permission },
          update: {
            $setOnInsert: {
              _id: new ObjectId(),
              role,
              permission,
              created_at: now,
            },
          },
          upsert: true,
        },
      })),
  );

  if (operations.length > 0) {
    await db.collection('venue_role_permissions').bulkWrite(operations);
  }
}
