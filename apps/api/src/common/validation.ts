import { BadRequestException } from '@nestjs/common';
import type { z } from 'zod';

export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new BadRequestException({
    code: 'VALIDATION_ERROR',
    message: 'Request validation failed',
    issues: result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}
