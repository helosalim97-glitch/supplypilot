import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiError, type ErrorEnvelope } from './api-error';
import type { RequestWithId } from './request-id';

/** Default codes for errors thrown by Nest itself or by guards. */
const CODES: Partial<Record<number, string>> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'too_many_requests',
};

function messageOf(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && message.length > 0) return message.map(String).join('; ');
  return exception.message;
}

/**
 * Turns every error into `{ error: { code, message, details?, requestId } }`.
 * Unexpected errors become a generic 500: their message and stack are logged
 * with the request id but never sent to the client.
 */
@Catch()
export class ErrorEnvelopeFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<RequestWithId>();
    const res = http.getResponse<Response>();
    const requestId = req.requestId ?? 'unknown';

    let status: number = HttpStatus.INTERNAL_SERVER_ERROR;
    let error: ErrorEnvelope['error'] = {
      code: 'internal_error',
      message: 'Internal server error',
      requestId,
    };

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      error = { code: exception.code, message: exception.message, requestId };
      if (exception.details?.length) error.details = exception.details;
    } else if (exception instanceof HttpException && exception.getStatus() < 500) {
      status = exception.getStatus();
      error = { code: CODES[status] ?? 'request_error', message: messageOf(exception), requestId };
    } else {
      const detail = exception instanceof Error ? exception.stack ?? exception.message : exception;
      const route = `${req.method} ${req.originalUrl ?? req.url}`;
      this.logger.error(`${route} failed [${requestId}]`, detail);
      if (exception instanceof HttpException) status = exception.getStatus();
    }

    const body: ErrorEnvelope = { error };
    res.status(status).json(body);
  }
}
