import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  AppUserEntity,
  DocumentEntity,
  DocumentReviewActionEntity,
  DocumentReviewRequestEntity,
  DocumentVersionEntity,
} from '@knowledge-base/database';
import { AccessControlModule } from '../access-control/access-control.module';
import { IngestionModule } from '../ingestion/ingestion.module';
import { DocumentReviewsController } from './document-reviews.controller';
import { DocumentReviewsService } from './document-reviews.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      AppUserEntity,
      DocumentEntity,
      DocumentVersionEntity,
      DocumentReviewRequestEntity,
      DocumentReviewActionEntity,
    ]),
    AccessControlModule,
    IngestionModule,
  ],
  controllers: [DocumentReviewsController],
  providers: [DocumentReviewsService],
  exports: [DocumentReviewsService],
})
export class DocumentReviewsModule {}
