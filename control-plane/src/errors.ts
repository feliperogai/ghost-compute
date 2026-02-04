import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Insufficient permissions') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (what: string) => new AppError(404, 'NOT_FOUND', `${what} not found`);
export const conflict = (message: string) => new AppError(409, 'CONFLICT', message);

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown; requestId: string };
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  const requestId = req.id;

  if (err instanceof AppError) {
    if (err.statusCode >= 500) req.log.error({ err }, 'application error');
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    } satisfies ErrorBody);
  }

  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.validation.map((v) => ({
          location: err.validationContext,
          path: v.instancePath,
          message: v.message,
        })),
        requestId,
      },
    } satisfies ErrorBody);
  }

  const statusCode = (err as FastifyError).statusCode;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    return reply.status(statusCode).send({
      error: { code: (err as FastifyError).code ?? 'BAD_REQUEST', message: err.message, requestId },
    } satisfies ErrorBody);
  }

  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({
    error: { code: 'INTERNAL', message: 'Internal server error', requestId },
  } satisfies ErrorBody);
}
