import { ObjectId, type Db } from 'mongodb';

import { AppError } from '../../shared/errors/app-error.js';
import type {
  MessageDocument,
  MessageDirection,
  MessageRecipientType,
  MessageView,
  Paginated,
  ThreadView,
} from './messaging.types.js';

/**
 * Person-to-person messaging between platform staff and the accounts they operate for.
 *
 * Two rules shape everything here:
 *
 *   1. A message is only ever addressed to an account that exists. The recipient is looked up
 *      in `partners` / `venue_owners` on every send, so a typo'd id fails at 404 instead of
 *      creating a thread nobody can read.
 *   2. Read receipts are one-directional. Staff mark inbound replies read; a recipient marks
 *      the outbound messages read. Neither side can clear the other's badge.
 */

export interface SendMessageInput {
  recipientType: MessageRecipientType;
  recipientId: string;
  subject?: string | undefined;
  body: string;
  senderAdminId: string;
}

export interface ReplyInput {
  recipientType: MessageRecipientType;
  recipientId: string;
  subject?: string | undefined;
  body: string;
  senderName: string;
}

export interface ListThreadInput {
  recipientType: MessageRecipientType;
  recipientId: string;
  page?: number;
  limit?: number;
}

export interface MessagingService {
  send(input: SendMessageInput): Promise<MessageView>;
  reply(input: ReplyInput): Promise<MessageView>;
  listThread(input: ListThreadInput): Promise<Paginated<MessageView>>;
  listThreads(input: { page?: number; limit?: number }): Promise<Paginated<ThreadView>>;
  /** Marks the messages the caller did not write as read. Returns how many changed. */
  markRead(input: {
    recipientType: MessageRecipientType;
    recipientId: string;
    side: 'ADMIN' | 'RECIPIENT';
  }): Promise<{ updated: number }>;
  unreadForRecipient(input: {
    recipientType: MessageRecipientType;
    recipientId: string;
  }): Promise<{ unread: number }>;
}

interface RecipientAccount {
  name: string;
  email: string | null;
  phone: string | null;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function threadKey(type: MessageRecipientType, id: string | ObjectId): string {
  return `${type}:${String(id)}`;
}

function toView(document: MessageDocument): MessageView {
  return {
    messageId: document._id.toHexString(),
    recipientType: document.recipient_type,
    recipientId: document.recipient_id.toHexString(),
    direction: document.direction,
    senderName: document.sender_name,
    subject: document.subject,
    body: document.body,
    readAt: document.read_at ? document.read_at.toISOString() : null,
    createdAt: document.created_at.toISOString(),
  };
}

function objectId(value: string, field: string): ObjectId {
  if (!ObjectId.isValid(value)) {
    throw new AppError({
      code: 'VALIDATION_ERROR',
      message: `${field} must be a 24-character id`,
      statusCode: 400,
    });
  }
  return new ObjectId(value);
}

export function createMessagingService(options: {
  db: Db;
  now?: () => Date;
}): MessagingService {
  const now = options.now ?? (() => new Date());
  const messages = () =>
    options.db.collection<MessageDocument>('admin_messages');

  /**
   * The admin access token carries an id and a role and nothing else, so the display name is
   * read here and copied onto the message — a thread stays readable after staff leave.
   */
  async function adminName(adminId: ObjectId): Promise<string> {
    const admin = await options.db
      .collection<{ _id: ObjectId; display_name?: string; email?: string }>(
        'admin_users',
      )
      .findOne({ _id: adminId }, { projection: { display_name: 1, email: 1 } });

    return admin?.display_name ?? admin?.email ?? 'Turf GDS support';
  }

  /** Resolves the display identity, and proves the account exists while doing it. */
  async function loadRecipient(
    type: MessageRecipientType,
    id: ObjectId,
  ): Promise<RecipientAccount> {
    if (type === 'PARTNER') {
      const partner = await options.db
        .collection<{
          _id: ObjectId;
          display_name?: string;
          legal_name?: string;
          email?: string;
          phone_e164?: string;
        }>('partners')
        .findOne(
          { _id: id },
          { projection: { display_name: 1, legal_name: 1, email: 1, phone_e164: 1 } },
        );

      if (!partner) {
        throw new AppError({
          code: 'PARTNER_NOT_FOUND',
          message: 'No partner with that id',
          statusCode: 404,
        });
      }

      return {
        name: partner.display_name ?? partner.legal_name ?? id.toHexString(),
        email: partner.email ?? null,
        phone: partner.phone_e164 ?? null,
      };
    }

    const owner = await options.db
      .collection<{
        _id: ObjectId;
        display_name?: string;
        legal_name?: string;
        email?: string;
        phone_e164?: string;
      }>('venue_owners')
      .findOne(
        { _id: id },
        { projection: { display_name: 1, legal_name: 1, email: 1, phone_e164: 1 } },
      );

    if (!owner) {
      throw new AppError({
        code: 'OWNER_NOT_FOUND',
        message: 'No venue owner with that id',
        statusCode: 404,
      });
    }

    return {
      name: owner.display_name ?? owner.legal_name ?? id.toHexString(),
      email: owner.email ?? null,
      phone: owner.phone_e164 ?? null,
    };
  }

  async function insert(input: {
    recipientType: MessageRecipientType;
    recipientId: ObjectId;
    direction: MessageDirection;
    senderAdminId: ObjectId | null;
    senderName: string;
    subject: string;
    body: string;
  }): Promise<MessageView> {
    const timestamp = now();
    const document: MessageDocument = {
      _id: new ObjectId(),
      thread_key: threadKey(input.recipientType, input.recipientId),
      recipient_type: input.recipientType,
      recipient_id: input.recipientId,
      direction: input.direction,
      sender_admin_id: input.senderAdminId,
      sender_name: input.senderName,
      subject: input.subject,
      body: input.body,
      read_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    };

    await messages().insertOne(document);
    return toView(document);
  }

  return {
    async send(input) {
      const recipientId = objectId(input.recipientId, 'recipientId');
      const body = input.body.trim();
      if (!body) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: 'body is required',
          statusCode: 400,
        });
      }

      // Throws 404 when the account is gone, which is the whole point of the lookup.
      await loadRecipient(input.recipientType, recipientId);

      const senderAdminId = objectId(input.senderAdminId, 'senderAdminId');

      return insert({
        recipientType: input.recipientType,
        recipientId,
        direction: 'OUTBOUND',
        senderAdminId,
        senderName: await adminName(senderAdminId),
        subject: (input.subject ?? '').trim().slice(0, 200),
        body: body.slice(0, 8_192),
      });
    },

    async reply(input) {
      const recipientId = objectId(input.recipientId, 'recipientId');
      const body = input.body.trim();
      if (!body) {
        throw new AppError({
          code: 'VALIDATION_ERROR',
          message: 'body is required',
          statusCode: 400,
        });
      }

      return insert({
        recipientType: input.recipientType,
        recipientId,
        direction: 'INBOUND',
        senderAdminId: null,
        senderName: input.senderName,
        subject: (input.subject ?? '').trim().slice(0, 200),
        body: body.slice(0, 8_192),
      });
    },

    async listThread(input) {
      const recipientId = objectId(input.recipientId, 'recipientId');
      const page = Math.max(1, input.page ?? 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
      const filter = { thread_key: threadKey(input.recipientType, recipientId) };

      const [items, total] = await Promise.all([
        messages()
          .find(filter)
          // Newest first on the wire; the client renders bottom-up.
          .sort({ created_at: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .toArray(),
        messages().countDocuments(filter),
      ]);

      return {
        items: items.map(toView),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.max(1, Math.ceil(total / limit)),
        },
      };
    },

    async listThreads(input) {
      const page = Math.max(1, input.page ?? 1);
      const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));

      // One group per thread: newest message, total count, and how many replies are unread.
      const grouped = await messages()
        .aggregate<{
          _id: string;
          last: MessageDocument;
          messageCount: number;
          unreadCount: number;
        }>([
          { $sort: { created_at: -1 } },
          {
            $group: {
              _id: '$thread_key',
              last: { $first: '$$ROOT' },
              messageCount: { $sum: 1 },
              unreadCount: {
                $sum: {
                  $cond: [
                    {
                      $and: [
                        { $eq: ['$direction', 'INBOUND'] },
                        { $eq: ['$read_at', null] },
                      ],
                    },
                    1,
                    0,
                  ],
                },
              },
            },
          },
          { $sort: { 'last.created_at': -1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit },
        ])
        .toArray();

      const total = (
        await messages().aggregate([{ $group: { _id: '$thread_key' } }, { $count: 'total' }]).toArray()
      )[0]?.total as number | undefined;

      const items: ThreadView[] = await Promise.all(
        grouped.map(async (group) => {
          const account = await loadRecipient(
            group.last.recipient_type,
            group.last.recipient_id,
          ).catch(() => null);

          return {
            recipientType: group.last.recipient_type,
            recipientId: group.last.recipient_id.toHexString(),
            // A deleted account keeps its thread readable rather than 500ing the list.
            recipientName: account?.name ?? group.last.recipient_id.toHexString(),
            recipientEmail: account?.email ?? null,
            recipientPhone: account?.phone ?? null,
            lastMessage: toView(group.last),
            messageCount: group.messageCount,
            unreadCount: group.unreadCount,
          };
        }),
      );

      return {
        items,
        pagination: {
          page,
          limit,
          total: total ?? 0,
          totalPages: Math.max(1, Math.ceil((total ?? 0) / limit)),
        },
      };
    },

    async markRead(input) {
      const recipientId = objectId(input.recipientId, 'recipientId');
      // Staff clear inbound replies; the account clears what staff sent it.
      const direction: MessageDirection =
        input.side === 'ADMIN' ? 'INBOUND' : 'OUTBOUND';

      const result = await messages().updateMany(
        {
          thread_key: threadKey(input.recipientType, recipientId),
          direction,
          read_at: null,
        },
        { $set: { read_at: now(), updated_at: now() } },
      );

      return { updated: result.modifiedCount };
    },

    async unreadForRecipient(input) {
      const recipientId = objectId(input.recipientId, 'recipientId');
      const unread = await messages().countDocuments({
        thread_key: threadKey(input.recipientType, recipientId),
        direction: 'OUTBOUND',
        read_at: null,
      });
      return { unread };
    },
  };
}
