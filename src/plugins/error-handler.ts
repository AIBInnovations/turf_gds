import type { FastifyError, FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

import { AppError } from '../shared/errors/app-error.js';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    requestId: string;
    details?: unknown;
  };
}

const errorHandlerPlugin: FastifyPluginAsync = async (fastify) => {
  fastify.setNotFoundHandler((request, reply) => {
    void reply.status(404).send({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: 'The requested route does not exist',
        requestId: request.id,
      },
    } satisfies ErrorBody);
  });

  fastify.setErrorHandler(
    (error: FastifyError, request, reply): void => {
      if (error.validation) {
        void reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'The request is invalid',
            requestId: request.id,
            details: error.validation,
          },
        } satisfies ErrorBody);
        return;
      }

      if (error instanceof AppError) {
        if (error.statusCode >= 500) {
          request.log.error({ err: error }, error.message);
        }

        const body: ErrorBody = {
          error: {
            code: error.code,
            message: error.message,
            requestId: request.id,
          },
        };

        if (error.details !== undefined) {
          body.error.details = error.details;
        }

        void reply.status(error.statusCode).send(body);
        return;
      }

      request.log.error({ err: error }, 'Unhandled request error');
      void reply.status(500).send({
        error: {
          code: 'INTERNAL_SERVER_ERROR',
          message: 'An unexpected error occurred',
          requestId: request.id,
        },
      } satisfies ErrorBody);
    },
  );
};

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
  fastify: '5.x',
});
