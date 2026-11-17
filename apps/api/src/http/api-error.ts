import { HttpException, HttpStatus } from '@nestjs/common';

export interface FieldError {
  field: string;
  message: string;
}

/** Body of every error response. */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: FieldError[];
    requestId: string;
  };
}

/** An HTTP error with a stable, machine-readable code and optional field details. */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: FieldError[],
  ) {
    super(message, status);
    this.name = 'ApiError';
  }
}

/** 422: the request was well-formed JSON but one or more fields are invalid. */
export class ValidationError extends ApiError {
  constructor(details: FieldError[]) {
    super(HttpStatus.UNPROCESSABLE_ENTITY, 'validation_failed', 'Some fields are invalid', details);
    this.name = 'ValidationError';
  }
}
