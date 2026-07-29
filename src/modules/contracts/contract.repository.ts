import type { ClientSession, Filter, ObjectId } from 'mongodb';

import type { DatabaseConnection } from '../../shared/database/database-connection.js';
import type { PartnerDocument } from '../identity/partner/partner-access.types.js';
import type { VenueDocument } from '../venue/venue.types.js';
import type { PartnerVenueContractDocument } from './contract.types.js';

export interface ContractRepository {
  findPartner(id: ObjectId): Promise<PartnerDocument | null>;
  findVenue(id: ObjectId): Promise<VenueDocument | null>;
  findById(id: ObjectId): Promise<PartnerVenueContractDocument | null>;
  list(input: {
    partnerId?: ObjectId;
    venueId?: ObjectId;
  }): Promise<PartnerVenueContractDocument[]>;
  findLatest(
    partnerId: ObjectId,
    venueId: ObjectId,
    session?: ClientSession,
  ): Promise<PartnerVenueContractDocument | null>;
  findEffective(
    partnerId: ObjectId,
    venueId: ObjectId,
    at: Date,
  ): Promise<PartnerVenueContractDocument | null>;
  supersede(input: {
    id: ObjectId;
    effectiveTo: Date;
    session: ClientSession;
  }): Promise<boolean>;
  insert(
    document: PartnerVenueContractDocument,
    session: ClientSession,
  ): Promise<void>;
}

export function createContractRepository(
  database: DatabaseConnection,
): ContractRepository {
  return {
    findPartner(id) {
      return database.db
        .collection<PartnerDocument>('partners')
        .findOne({ _id: id });
    },
    findVenue(id) {
      return database.db
        .collection<VenueDocument>('venues')
        .findOne({ _id: id });
    },
    findById(id) {
      return database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .findOne({ _id: id });
    },
    list(input) {
      const query: Filter<PartnerVenueContractDocument> = {};
      if (input.partnerId) {
        query.partner_id = input.partnerId;
      }
      if (input.venueId) {
        query.venue_id = input.venueId;
      }
      return database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .find(query)
        .sort({ partner_id: 1, venue_id: 1, effective_from: -1 })
        .toArray();
    },
    findLatest(partnerId, venueId, session) {
      return database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .findOne(
          { partner_id: partnerId, venue_id: venueId, status: 'ACTIVE' },
          {
            ...(session ? { session } : {}),
            sort: { effective_from: -1 },
          },
        );
    },
    findEffective(partnerId, venueId, at) {
      return database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .find({
          partner_id: partnerId,
          venue_id: venueId,
          status: 'ACTIVE',
          effective_from: { $lte: at },
          $or: [
            { effective_to: null },
            { effective_to: { $gt: at } },
          ],
        })
        .sort({ effective_from: -1 })
        .limit(1)
        .next();
    },
    async supersede(input) {
      const result = await database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .updateOne(
          { _id: input.id, status: 'ACTIVE', effective_to: null },
          {
            $set: {
              effective_to: input.effectiveTo,
              updated_at: new Date(),
            },
          },
          { session: input.session },
        );
      return result.modifiedCount === 1;
    },
    async insert(document, session) {
      await database.db
        .collection<PartnerVenueContractDocument>(
          'partner_venue_contracts',
        )
        .insertOne(document, { session });
    },
  };
}
