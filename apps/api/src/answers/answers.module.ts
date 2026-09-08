import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { SearchModule } from '../search/search.module';
import { AnswersController } from './answers.controller';
import { AnswersService } from './answers.service';
import { ConversationRetentionService } from './conversation-retention.service';
import { ConversationsService } from './conversations.service';
import { DocumentsModule } from '../documents/documents.module';
import { DocumentToolsService } from './document-tools.service';
import { SystemGovernanceModule } from '../system-governance/system-governance.module';
import { AnswerFeedbackService } from './answer-feedback.service';

@Module({
  imports: [AccessControlModule, SearchModule, DocumentsModule, SystemGovernanceModule],
  controllers: [AnswersController],
  providers: [
    AnswersService,
    AnswerFeedbackService,
    ConversationsService,
    ConversationRetentionService,
    DocumentToolsService,
  ],
})
export class AnswersModule {}
