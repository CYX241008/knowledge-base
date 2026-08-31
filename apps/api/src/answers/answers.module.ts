import { Module } from '@nestjs/common';
import { SearchModule } from '../search/search.module';
import { AnswersController } from './answers.controller';
import { AnswersService } from './answers.service';
import { ConversationRetentionService } from './conversation-retention.service';
import { ConversationsService } from './conversations.service';

@Module({
  imports: [SearchModule],
  controllers: [AnswersController],
  providers: [AnswersService, ConversationsService, ConversationRetentionService],
})
export class AnswersModule {}
