import type { INestApplication } from '@nestjs/common';
import { ErrorEnvelopeFilter } from './error-envelope.filter';
import { requestIdMiddleware } from './request-id';

/** HTTP behaviour shared by the server and the API tests. */
export function configureApp(app: INestApplication): INestApplication {
  app.use(requestIdMiddleware);
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  return app;
}
