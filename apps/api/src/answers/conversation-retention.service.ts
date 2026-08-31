import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { ChatConversationEntity } from '@knowledge-base/database';
import { logEvent } from '@knowledge-base/observability';
import { DataSource, LessThan } from 'typeorm';

@Injectable()
export class ConversationRetentionService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
  ) {}

  onModuleInit(): void {
    if (!this.config.getOrThrow('CHAT_RETENTION_CLEANUP_ENABLED')) return;
    this.runCleanup();
    this.timer = setInterval(
      () => this.runCleanup(),
      this.config.getOrThrow('CHAT_RETENTION_CLEANUP_INTERVAL_MS'),
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanup(now = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.getOrThrow('CHAT_RETENTION_DAYS') * 24 * 60 * 60 * 1_000,
    );
    const result = await this.dataSource
      .getRepository(ChatConversationEntity)
      .delete({ updatedAt: LessThan(cutoff) });
    const deleted = result.affected ?? 0;
    if (deleted > 0) logEvent('chat.retention_cleanup_completed', { deleted, cutoff });
    return deleted;
  }

  private runCleanup(): void {
    void this.cleanup().catch((error) =>
      logEvent('chat.retention_cleanup_failed', {
        message: error instanceof Error ? error.message : 'Unknown retention cleanup error',
      }),
    );
  }
}
