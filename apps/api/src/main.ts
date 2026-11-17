import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { configureApp } from './http/configure-app';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = configureApp(await NestFactory.create(AppModule));
  app.enableShutdownHooks();
  await app.listen(config.port);
  Logger.log(`API listening on port ${config.port}`, 'Bootstrap');
}

void bootstrap();
