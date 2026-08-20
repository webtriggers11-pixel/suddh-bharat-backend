import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // CORS: allow ALL origins for now (dev). `origin: true` reflects the request
  // origin, which also works with credentials. Tighten before prod (ADR-0010).
  app.enableCors({
    origin: true,
    credentials: true,
  });

  await app.listen(config.get<number>('PORT', 3001));
}
void bootstrap();
