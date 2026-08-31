import { Global, Module } from '@nestjs/common';
import { AccessPolicyService } from './access-policy.service';
import { AuthenticationGuard } from './authentication.guard';
import { AuthController } from './auth.controller';
import { PrincipalResolverService } from './principal-resolver.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [AuthenticationGuard, AccessPolicyService, PrincipalResolverService],
  exports: [AuthenticationGuard, AccessPolicyService, PrincipalResolverService],
})
export class AuthModule {}
