import type { Db, Document } from 'mongodb';

import { ObjectId } from 'mongodb';

import {
  PERMISSIONS,
  type VenueMembershipRole,
  type VenuePermission,
} from './owner/owner.types.js';

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
    fcm_tokens: { bsonType: 'array' },
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
    'submitted_at',
    'reviewed_by',
    'reviewed_at',
    'rejection_reason',
    'expires_at',
    'created_at',
    'updated_at',
  ],
  {
    subject_type: { enum: ['VENUE_OWNER', 'PARTNER'] },
    subject_id: { bsonType: 'objectId' },
    verification_type: { bsonType: 'string' },
    status: {
      enum: [
        'DRAFT',
        'SUBMITTED',
        'IN_REVIEW',
        'VERIFIED',
        'REJECTED',
        'EXPIRED',
      ],
    },
    is_current: { bsonType: 'bool' },
    submitted_at: { bsonType: ['date', 'null'] },
    reviewed_by: { bsonType: ['objectId', 'null'] },
    reviewed_at: { bsonType: ['date', 'null'] },
    rejection_reason: { bsonType: ['string', 'null'] },
    expires_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const kycDocumentValidator = documentValidator(
  [
    'kyc_verification_id',
    'document_type',
    'file',
    'status',
    'created_at',
    'updated_at',
  ],
  {
    kyc_verification_id: { bsonType: 'objectId' },
    document_type: { bsonType: 'string' },
    file: { bsonType: 'object' },
    status: { enum: ['ACTIVE', 'REJECTED', 'DELETED'] },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const partnerValidator = documentValidator(
  [
    'legal_name',
    'display_name',
    'email',
    'status',
    'integration_review_status',
    'sandbox_approved_by',
    'sandbox_approved_at',
    'production_approved_by',
    'production_approved_at',
    'created_at',
    'updated_at',
  ],
  {
    legal_name: { bsonType: 'string' },
    display_name: { bsonType: 'string' },
    email: { bsonType: 'string' },
    status: { enum: ['ONBOARDING', 'SANDBOX', 'ACTIVE', 'SUSPENDED'] },
    integration_review_status: {
      enum: ['NOT_STARTED', 'PENDING', 'PASSED', 'FAILED'],
    },
    sandbox_approved_by: { bsonType: ['objectId', 'null'] },
    sandbox_approved_at: { bsonType: ['date', 'null'] },
    production_approved_by: { bsonType: ['objectId', 'null'] },
    production_approved_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
    updated_at: { bsonType: 'date' },
  },
);

const partnerKeyValidator = documentValidator(
  [
    'partner_id',
    'environment',
    'key_prefix',
    'secret_hash',
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
    secret_hash: { bsonType: 'string' },
    signing_secret_hash: { bsonType: 'string' },
    scopes: { bsonType: 'array', items: { bsonType: 'string' } },
    status: { enum: ['ACTIVE', 'REVOKED'] },
    last_used_at: { bsonType: ['date', 'null'] },
    expires_at: { bsonType: ['date', 'null'] },
    created_at: { bsonType: 'date' },
    revoked_at: { bsonType: ['date', 'null'] },
  },
);

const usageValidator = documentValidator(
  [
    'partner_id',
    'environment',
    'usage_date',
    'request_count',
    'error_count',
    'rate_limit_count',
    'p95_latency_ms',
    'created_at',
    'updated_at',
  ],
  {
    partner_id: { bsonType: 'objectId' },
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    usage_date: { bsonType: 'date' },
    request_count: { bsonType: ['int', 'long'] },
    error_count: { bsonType: ['int', 'long'] },
    rate_limit_count: { bsonType: ['int', 'long'] },
    p95_latency_ms: { bsonType: ['int', 'long'] },
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
    'subscribed_events',
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
    subscribed_events: {
      bsonType: 'array',
      items: { bsonType: 'string' },
    },
    status: {
      enum: ['PENDING_VERIFICATION', 'ACTIVE', 'DISABLED'],
    },
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
      'status',
      'failed_login_count',
      'locked_until',
      'last_login_at',
      'sessions',
      'fcm_tokens',
      'notifications',
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
      status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
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
            'ip_address',
            'user_agent',
            'created_at',
            'expires_at',
            'revoked_at',
          ],
          properties: {
            token_hash: { bsonType: 'string' },
            ip_address: { bsonType: 'string' },
            user_agent: { bsonType: 'string' },
            created_at: { bsonType: 'date' },
            expires_at: { bsonType: 'date' },
            revoked_at: { bsonType: ['date', 'null'] },
          },
        },
      },
      fcm_tokens: { bsonType: 'array' },
      notifications: { bsonType: 'array' },
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
      'updated_at',
    ],
    properties: {
      _id: { bsonType: 'objectId' },
      owner_id: { bsonType: 'objectId' },
      venue_id: { bsonType: 'objectId' },
      role: { enum: ['OWNER', 'MANAGER', 'STAFF'] },
      status: { enum: ['ACTIVE', 'REVOKED'] },
      created_at: { bsonType: 'date' },
      updated_at: { bsonType: 'date' },
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
  await ensureValidatedCollection(db, 'admin_users', adminValidator);
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
    { email: 1 },
    { unique: true, name: 'uq_partners_email' },
  );
  await db.collection('partners').createIndex(
    { legal_name: 1 },
    {
      unique: true,
      name: 'uq_partners_legal_name',
      collation: { locale: 'en', strength: 2 },
    },
  );
  await db.collection('partner_api_keys').createIndex(
    { key_prefix: 1 },
    { unique: true, name: 'uq_partner_keys_prefix' },
  );
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
