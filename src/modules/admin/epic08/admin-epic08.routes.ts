import type { FastifyPluginAsync } from 'fastify';

import type { AdminAuthService } from '../../identity/platform/auth.service.js';
import {
  createAdminAuthenticationHook,
  requireAdminRole,
} from '../../identity/shared/auth-context.js';
import type { AdminEpic08Service } from './admin-epic08.service.js';

interface Options {
  service: AdminEpic08Service;
  adminAuthService: AdminAuthService;
}
type Environment = 'SANDBOX' | 'PRODUCTION';

const idParams = {
  type: 'object', additionalProperties: false, required: ['venueId'],
  properties: { venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } },
} as const;
const reportQuery = {
  type: 'object', additionalProperties: false,
  required: ['environment', 'from', 'to'],
  properties: {
    environment: { enum: ['SANDBOX', 'PRODUCTION'] },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
    partnerId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
    status: { type: 'string', minLength: 1, maxLength: 40 },
    page: { type: 'integer', minimum: 1 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    groupBy: { enum: ['DAY', 'VENUE', 'PARTNER'] },
    dimension: { enum: ['VENUE', 'PARTNER'] },
  },
} as const;

const routes: FastifyPluginAsync<Options> = async (fastify, options) => {
  fastify.addHook('preHandler', createAdminAuthenticationHook(options.adminAuthService));

  fastify.get<{ Querystring: {
    environment?: Environment; status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
    ownerId?: string; q?: string; page?: number; limit?: number;
  } }>('/venues', { schema: { querystring: {
    type: 'object', additionalProperties: false, properties: {
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] },
      ownerId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      q: { type: 'string', maxLength: 120 }, page: { type: 'integer', minimum: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  } } }, async (request) => options.service.venues.listVenues({
    ...request.query, ...(request.query.q ? { query: request.query.q } : {}),
  }));

  fastify.post<{ Body: {
    ownerId: string; environment: Environment; legalName: string; displayName: string;
    timezone: string; address: { line1: string; line2?: string; city: string; state: string; postalCode: string; country: string };
    latitude: number; longitude: number;
  } }>('/venues', { schema: { body: {
    type: 'object', additionalProperties: false,
    required: ['ownerId', 'environment', 'legalName', 'displayName', 'timezone', 'address', 'latitude', 'longitude'],
    properties: {
      ownerId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
      environment: { enum: ['SANDBOX', 'PRODUCTION'] },
      legalName: { type: 'string', minLength: 2, maxLength: 200 },
      displayName: { type: 'string', minLength: 2, maxLength: 120 },
      timezone: { type: 'string', minLength: 1, maxLength: 100 },
      address: { type: 'object', additionalProperties: false, required: ['line1', 'city', 'state', 'postalCode', 'country'], properties: {
        line1: { type: 'string' }, line2: { type: 'string' }, city: { type: 'string' }, state: { type: 'string' }, postalCode: { type: 'string' }, country: { type: 'string' },
      } },
      latitude: { type: 'number', minimum: -90, maximum: 90 },
      longitude: { type: 'number', minimum: -180, maximum: 180 },
    },
  } } }, async (request, reply) => {
    const admin = requireAdminRole(request);
    return reply.status(201).send(await options.service.venues.createVenue({
      ...request.body, adminId: admin.adminId, correlationId: request.id,
    }));
  });

  fastify.get<{ Params: { venueId: string } }>('/venues/:venueId', { schema: { params: idParams } }, async (request) => options.service.venues.getVenue(request.params.venueId));
  fastify.patch<{ Params: { venueId: string }; Body: {
    version: number; legalName?: string; displayName?: string; timezone?: string;
    status?: 'PENDING' | 'ACTIVE' | 'SUSPENDED'; reason?: string;
  } }>('/venues/:venueId', { schema: { params: idParams, body: {
    type: 'object', additionalProperties: false, required: ['version'], minProperties: 2,
    properties: { version: { type: 'integer', minimum: 1 }, legalName: { type: 'string' }, displayName: { type: 'string' }, timezone: { type: 'string' }, status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED'] }, reason: { type: 'string', maxLength: 1000 } },
  } } }, async (request) => {
    const admin = requireAdminRole(request);
    const { version, ...changes } = request.body;
    return options.service.venues.updateVenue({ ...changes, venueId: request.params.venueId, expectedVersion: version, adminId: admin.adminId, correlationId: request.id });
  });

  fastify.get<{ Params: { venueId: string } }>('/venues/:venueId/courts', { schema: { params: idParams } }, async (request) => options.service.venues.listCourts(request.params.venueId));
  fastify.post<{ Params: { venueId: string }; Body: {
    name: string; sportType: 'FOOTBALL' | 'CRICKET' | 'BADMINTON' | 'TENNIS' | 'PICKLEBALL' | 'MULTI_SPORT' | 'OTHER';
    surfaceType: string; capacity: number; bookingMode: 'OPEN_TIME' | 'FIXED_SLOT' | 'BOTH';
    minBookingMinutes: number; bookingIncrementMinutes: number; fixedSlotDurationMinutes?: number | null; fixedSlotAnchorMinutes?: number | null;
  } }>('/venues/:venueId/courts', { schema: { params: idParams, body: {
    type: 'object', additionalProperties: false, required: ['name', 'sportType', 'surfaceType', 'capacity', 'bookingMode', 'minBookingMinutes', 'bookingIncrementMinutes'],
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 120 }, sportType: { enum: ['FOOTBALL', 'CRICKET', 'BADMINTON', 'TENNIS', 'PICKLEBALL', 'MULTI_SPORT', 'OTHER'] },
      surfaceType: { type: 'string', minLength: 1 }, capacity: { type: 'integer', minimum: 1 },
      bookingMode: { enum: ['OPEN_TIME', 'FIXED_SLOT', 'BOTH'] }, minBookingMinutes: { type: 'integer', minimum: 60 },
      bookingIncrementMinutes: { type: 'integer', minimum: 5 }, fixedSlotDurationMinutes: { type: ['integer', 'null'] }, fixedSlotAnchorMinutes: { type: ['integer', 'null'] },
    },
  } } }, async (request, reply) => {
    const admin = requireAdminRole(request);
    return reply.status(201).send(await options.service.venues.createCourt({ ...request.body, venueId: request.params.venueId, adminId: admin.adminId, correlationId: request.id }));
  });

  const courtParams = { type: 'object', additionalProperties: false, required: ['venueId', 'courtId'], properties: {
    venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' }, courtId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' },
  } } as const;
  fastify.get<{ Params: { venueId: string; courtId: string } }>('/venues/:venueId/courts/:courtId', { schema: { params: courtParams } }, async (request) => options.service.venues.getCourt(request.params.venueId, request.params.courtId));
  fastify.patch<{ Params: { venueId: string; courtId: string }; Body: { version: number; name?: string; surfaceType?: string; capacity?: number; status?: 'AVAILABLE' | 'UNAVAILABLE'; reason?: string } }>('/venues/:venueId/courts/:courtId', { schema: { params: courtParams, body: {
    type: 'object', additionalProperties: false, required: ['version'], minProperties: 2,
    properties: { version: { type: 'integer', minimum: 1 }, name: { type: 'string' }, surfaceType: { type: 'string' }, capacity: { type: 'integer', minimum: 1 }, status: { enum: ['AVAILABLE', 'UNAVAILABLE'] }, reason: { type: 'string', maxLength: 1000 } },
  } } }, async (request) => {
    const admin = requireAdminRole(request); const { version, ...changes } = request.body;
    return options.service.venues.updateCourt({ ...changes, venueId: request.params.venueId, courtId: request.params.courtId, expectedVersion: version, adminId: admin.adminId, correlationId: request.id });
  });

  for (const kind of ['bookings', 'revenue', 'activity'] as const) {
    fastify.get<{ Querystring: ReportQuery }>(`/reports/${kind}`, { schema: { querystring: reportQuery } }, async (request) => {
      const values = parsedReport(request.query);
      if (kind === 'bookings') return options.service.bookingReport(values);
      if (kind === 'revenue') return options.service.revenueReport({ ...values, ...(request.query.groupBy ? { groupBy: request.query.groupBy } : {}) });
      return options.service.activityReport({ ...values, dimension: request.query.dimension ?? 'VENUE' });
    });
    fastify.get<{ Querystring: ReportQuery }>(`/reports/${kind}/export`, { schema: { querystring: reportQuery } }, async (request, reply) => {
      requireAdminRole(request);
      const body = await options.service.exportReport(kind, { ...parsedReport(request.query), ...(request.query.groupBy ? { groupBy: request.query.groupBy } : {}), ...(request.query.dimension ? { dimension: request.query.dimension } : {}) });
      return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${kind}.csv"`).send(body);
    });
  }

  fastify.get<{ Params: { bookingId: string }; Querystring: { environment: Environment } }>('/disputes/bookings/:bookingId', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['bookingId'], properties: { bookingId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } },
    querystring: { type: 'object', additionalProperties: false, required: ['environment'], properties: { environment: { enum: ['SANDBOX', 'PRODUCTION'] } } },
  } }, async (request) => options.service.dispute(request.params.bookingId, request.query.environment));
  fastify.post<{ Params: { bookingId: string }; Body: { environment: Environment; version: number; note: string } }>('/disputes/bookings/:bookingId/notes', { schema: {
    params: { type: 'object', additionalProperties: false, required: ['bookingId'], properties: { bookingId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' } } },
    body: { type: 'object', additionalProperties: false, required: ['environment', 'version', 'note'], properties: { environment: { enum: ['SANDBOX', 'PRODUCTION'] }, version: { type: 'integer', minimum: 1 }, note: { type: 'string', minLength: 1, maxLength: 2000 } } },
  } }, async (request) => {
    const admin = requireAdminRole(request);
    return options.service.addDisputeNote({ bookingId: request.params.bookingId, environment: request.body.environment, expectedVersion: request.body.version, note: request.body.note, adminId: admin.adminId, correlationId: request.id });
  });

  fastify.get<{ Querystring: { environment?: Environment; venueId?: string; health?: 'HEALTHY' | 'STALE' | 'EMPTY' | 'DISABLED'; page?: number; limit?: number } }>('/operations/inventory-health', { schema: { querystring: {
    type: 'object', additionalProperties: false, properties: { environment: { enum: ['SANDBOX', 'PRODUCTION'] }, venueId: { type: 'string', pattern: '^[a-fA-F0-9]{24}$' }, health: { enum: ['HEALTHY', 'STALE', 'EMPTY', 'DISABLED'] }, page: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
  } } }, async (request) => options.service.inventoryHealth(request.query));

  fastify.get<{Querystring:{status?:string;q?:string;page?:number;limit?:number}}>('/partners',{schema:{querystring:{type:'object',additionalProperties:false,properties:{status:{enum:['PENDING','ACTIVE','SUSPENDED']},q:{type:'string',maxLength:120},page:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}},async r=>options.service.listPartners(r.query));
  fastify.get<{Params:{partnerId:string}}>('/partners/:partnerId',{schema:{params:{type:'object',additionalProperties:false,required:['partnerId'],properties:{partnerId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}}}},async r=>options.service.partnerDetail(r.params.partnerId));
  fastify.get<{Querystring:{partnerId?:string;environment?:Environment;from?:string;to?:string;page?:number;limit?:number}}>('/reports/partner-api-usage',{schema:{querystring:{type:'object',additionalProperties:false,properties:{partnerId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'},environment:{enum:['SANDBOX','PRODUCTION']},from:{type:'string',format:'date-time'},to:{type:'string',format:'date-time'},page:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}},async r=>{const{from,to,...rest}=r.query;return options.service.partnerApiUsage({...rest,...(from?{from:new Date(from)}:{}),...(to?{to:new Date(to)}:{})});});
  fastify.get<{Querystring:{environment?:Environment;page?:number;limit?:number}}>('/disputes',{schema:{querystring:{type:'object',additionalProperties:false,properties:{environment:{enum:['SANDBOX','PRODUCTION']},page:{type:'integer',minimum:1},limit:{type:'integer',minimum:1,maximum:100}}}}},async r=>options.service.listDisputes(r.query));
  fastify.post<{Params:{bookingId:string};Body:{environment:Environment;version:number;resolution:'CONFIRMED'|'CANCELLED'|'REFUNDED';note:string}}>('/disputes/bookings/:bookingId/resolve',{schema:{params:{type:'object',additionalProperties:false,required:['bookingId'],properties:{bookingId:{type:'string',pattern:'^[a-fA-F0-9]{24}$'}}},body:{type:'object',additionalProperties:false,required:['environment','version','resolution','note'],properties:{environment:{enum:['SANDBOX','PRODUCTION']},version:{type:'integer',minimum:1},resolution:{enum:['CONFIRMED','CANCELLED','REFUNDED']},note:{type:'string',minLength:1,maxLength:2000}}}}},async r=>{const admin=requireAdminRole(r);return options.service.resolveDispute({bookingId:r.params.bookingId,expectedVersion:r.body.version,adminId:admin.adminId,correlationId:r.id,...r.body});});
  fastify.get('/operations/health',async()=>options.service.operationsHealth());
};

interface ReportQuery {
  environment: Environment; from: string; to: string; venueId?: string; partnerId?: string;
  status?: string; page?: number; limit?: number; groupBy?: 'DAY' | 'VENUE' | 'PARTNER'; dimension?: 'VENUE' | 'PARTNER';
}
function parsedReport(value: ReportQuery) {
  return {
    environment: value.environment, from: new Date(value.from), to: new Date(value.to),
    ...(value.venueId ? { venueId: value.venueId } : {}), ...(value.partnerId ? { partnerId: value.partnerId } : {}),
    ...(value.status ? { status: value.status } : {}), ...(value.page ? { page: value.page } : {}), ...(value.limit ? { limit: value.limit } : {}),
  };
}

export default routes;
