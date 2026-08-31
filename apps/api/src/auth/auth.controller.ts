import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  buildSuccess,
  type ApiResponse,
  type AuthSessionResponse,
} from '@knowledge-base/contracts';
import { AuthenticationGuard } from './authentication.guard';
import type { AuthContext } from './auth-context';
import { CurrentAuth } from './current-auth.decorator';

@Controller('auth')
@UseGuards(AuthenticationGuard)
export class AuthController {
  @Get('me')
  currentSession(@CurrentAuth() auth: AuthContext): ApiResponse<AuthSessionResponse> {
    return buildSuccess({
      tenantId: auth.tenantId,
      userId: auth.userId,
      principalIds: [...auth.principalIds].sort(),
      mode: auth.mode,
    });
  }
}
