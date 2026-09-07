import { Module } from '@nestjs/common';
import { AccessControlModule } from '../access-control/access-control.module';
import { SearchModule } from '../search/search.module';
import { AnswersController } from './answers.controller';
import { AnswersService } from './answers.service';
import { ConversationRetentionService } from './conversation-retention.service';
import { ConversationsService } from './conversations.service';
import { DocumentsModule } from '../documents/documents.module';
import { DocumentToolsService } from './document-tools.service';

@Module({
  imports: [AccessControlModule, SearchModule, DocumentsModule],
  controllers: [AnswersController],
  providers: [
    AnswersService,
    ConversationsService,
    ConversationRetentionService,
    DocumentToolsService,
  ],
})
export class AnswersModule {}
