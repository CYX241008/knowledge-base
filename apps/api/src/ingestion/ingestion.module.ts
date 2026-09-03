import { BullModule } from '@nestjs/bullmq';
import { forwardRef, Module } from '@nestjs/common';
import {
  DOCUMENT_ACL_PROJECTION_QUEUE,
  DOCUMENT_CLEANUP_QUEUE,
  DOCUMENT_INGESTION_QUEUE,
  DOCUMENT_SEARCH_PROJECTION_QUEUE,
} from '@knowledge-base/contracts';
import { IngestionJobEntity, OutboxEventEntity } from '@knowledge-base/database';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IngestionController } from './ingestion.controller';
import { IngestionService } from './ingestion.service';
import { OutboxDispatcherService } from './outbox-dispatcher.service';
import { AccessControlModule } from '../access-control/access-control.module';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: DOCUMENT_INGESTION_QUEUE },
      { name: DOCUMENT_CLEANUP_QUEUE },
      { name: DOCUMENT_ACL_PROJECTION_QUEUE },
      { name: DOCUMENT_SEARCH_PROJECTION_QUEUE },
    ),
    TypeOrmModule.forFeature([IngestionJobEntity, OutboxEventEntity]),
    forwardRef(() => AccessControlModule),
  ],
  controllers: [IngestionController],
  providers: [IngestionService, OutboxDispatcherService],
  exports: [IngestionService],
})
export class IngestionModule {}
