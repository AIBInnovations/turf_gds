import type { ObjectId } from 'mongodb';

/**
 * Direct messages between platform staff and the two kinds of account that can be written to:
 * an API partner, or a venue owner.
 *
 * This is deliberately *not* the outbox. `outbox_events` is machine-to-machine — a webhook
 * fired at a partner's server with retries and signatures. A message here is a person writing
 * to a person, so it has a subject, a body, a read receipt, and no delivery machinery.
 *
 * One document per message, not per thread. Threads are derived: every message carries a
 * `thread_key` of `"<recipient_type>:<recipient_id>"`, which is what the list endpoints group
 * and sort on. An append-only collection keeps concurrent replies from fighting over one
 * document, and a thread that grows past a few hundred messages still pages cleanly.
 */

export type MessageRecipientType = 'PARTNER' | 'VENUE_OWNER';

/** OUTBOUND is staff → account. INBOUND is the account replying. */
export type MessageDirection = 'OUTBOUND' | 'INBOUND';

export interface MessageDocument {
  _id: ObjectId;
  thread_key: string;
  recipient_type: MessageRecipientType;
  recipient_id: ObjectId;
  direction: MessageDirection;
  /** Set on OUTBOUND only — which admin wrote it. Null on a reply. */
  sender_admin_id: ObjectId | null;
  /** Display name captured at send time, so a renamed or disabled admin still reads correctly. */
  sender_name: string;
  subject: string;
  body: string;
  /** When the *other* side read it: the recipient for OUTBOUND, staff for INBOUND. */
  read_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageView {
  messageId: string;
  recipientType: MessageRecipientType;
  recipientId: string;
  direction: MessageDirection;
  senderName: string;
  subject: string;
  body: string;
  readAt: string | null;
  createdAt: string;
}

export interface ThreadView {
  recipientType: MessageRecipientType;
  recipientId: string;
  /** Resolved from `partners` or `venue_owners`; falls back to the id when the account is gone. */
  recipientName: string;
  recipientEmail: string | null;
  recipientPhone: string | null;
  lastMessage: MessageView;
  messageCount: number;
  /** Replies staff have not read yet. */
  unreadCount: number;
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  pagination: Pagination;
}
