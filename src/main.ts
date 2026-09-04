import helmet from 'helmet';
import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/http-exception.filter';
import { initSentry } from './config/sentry';

async function bootstrap() {
  initSentry();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(PinoLogger));
  app.use(helmet());
  const trustProxy = process.env.TRUST_PROXY
    ? process.env.TRUST_PROXY === 'true'
    : process.env.NODE_ENV === 'production';
  if (trustProxy) {
    (app.getHttpAdapter().getInstance() as import('express').Application).set(
      'trust proxy',
      1,
    );
  }
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const config = new DocumentBuilder()
    .setTitle('Clothing Shop API')
    .setDescription('API cho FE Website (khách hàng) — clothing-shop')
    .setVersion('0.1')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document);

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  Logger.log(`🚀 Server running on http://localhost:${port}`, 'Bootstrap');
  Logger.log(
    `📄 Swagger docs at http://localhost:${port}/api/docs`,
    'Bootstrap',
  );
}
void bootstrap();
