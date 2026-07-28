import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = isHttpException ? exception.getResponse() : null;
    const message =
      exceptionResponse &&
      typeof exceptionResponse === 'object' &&
      'message' in exceptionResponse
        ? (exceptionResponse as Record<string, unknown>).message
        : (exception as Error)?.message || 'Internal server error';

    const error =
      exceptionResponse &&
      typeof exceptionResponse === 'object' &&
      'error' in exceptionResponse
        ? (exceptionResponse as Record<string, unknown>).error
        : HttpStatus[statusCode];

    this.logger.error(
      `${request.method} ${request.url} -> ${statusCode}`,
      isHttpException ? undefined : (exception as Error)?.stack,
    );

    response.status(statusCode).json({
      statusCode,
      message,
      error,
      timestamp: new Date().toISOString(),
      path: request.url,
    });
  }
}
