import { ObjectId } from 'mongodb';
import type { DatabaseConnection } from '../database/database-connection.js';
import type { OutboxRepository } from './outbox.repository.js';

export interface OwnerEventPublisher {
  publish(input:{aggregateType:'VENUE'|'COURT'|'INVENTORY';aggregateId:ObjectId;venueId:ObjectId;eventType:'VENUE_UPDATED'|'COURT_UPDATED'|'AVAILABILITY_CHANGED';eventVersion:number;correlationId:string;payload:Record<string,unknown>;now?:Date}):Promise<void>;
}
export function createOwnerEventPublisher(database:DatabaseConnection,outbox:OutboxRepository):OwnerEventPublisher{return{async publish(input){await database.withTransaction(async({session})=>{const venue=await database.db.collection<{environment:'SANDBOX'|'PRODUCTION'}>('venues').findOne({_id:input.venueId},{session,projection:{environment:1}});if(!venue)return;await outbox.enqueue({aggregateType:input.aggregateType,aggregateId:input.aggregateId,partnerId:null,venueId:input.venueId,environment:venue.environment,eventType:input.eventType,eventVersion:input.eventVersion,correlationId:input.correlationId,payload:input.payload,now:input.now??new Date(),session});});}};}
