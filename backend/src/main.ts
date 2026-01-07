import { NestFactory } from '@nestjs/core';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS for frontend
  app.enableCors({
    origin: true,
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global prefix
  app.setGlobalPrefix('api');

  // Swagger Documentation
  const config = new DocumentBuilder()
    .setTitle('Travel Guide Book Generator API')
    .setDescription(
      'API for generating professional travel guide books in multiple languages with AI-powered content generation, formatting, and translation',
    )
    .setVersion('1.0')
    .addTag('projects', 'Book project management')
    .addTag('content', 'Content generation')
    .addTag('translation', 'Multi-language translation')
    .addTag('documents', 'PDF and DOCX generation')
    .addTag('images', 'Image upload and management')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Enter JWT token',
        in: 'header',
      },
      'JWT-auth',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api/docs', app, document, {
    customSiteTitle: 'Travel Guide Generator API Docs',
    customCss: `
      .topbar-wrapper img { content: url('https://via.placeholder.com/150x50?text=Travel+Guide'); }
      .swagger-ui .topbar { background-color: #2c3e50; }
    `,
    swaggerOptions: {
      persistAuthorization: true,
      tagsSorter: 'alpha',
      operationsSorter: 'alpha',
    },
  });

  const port = process.env.PORT || 4000;
  await app.listen(port);

  console.log(
    `🚀 Travel Guide Generator API is running on: http://localhost:${port}`,
  );
  console.log(
    `📚 API Documentation available at: http://localhost:${port}/api/docs`,
  );
  console.log(
    `🗄️  Database: ${process.env.DATABASE_URL?.split('@')[1]?.split('?')[0] || 'Not configured'}`,
  );
}

bootstrap();
