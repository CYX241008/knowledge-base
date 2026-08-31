import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import { DocumentAssetEntity, DocumentVersionEntity } from '@knowledge-base/database';
import { ObjectStorage } from '@knowledge-base/object-storage';
import { logEvent } from '@knowledge-base/observability';
import { DataSource } from 'typeorm';
import { OBJECT_STORAGE } from './worker.constants';

@Injectable()
export class OrphanObjectCleanupService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    @Inject(DataSource) private readonly dataSource: DataSource,
    @Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  onModuleInit(): void {
    if (!this.config.getOrThrow('ORPHAN_CLEANUP_ENABLED')) return;
    const intervalMs = this.config.getOrThrow('ORPHAN_CLEANUP_INTERVAL_MS');
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const versionRows = await this.dataSource
        .getRepository(DocumentVersionEntity)
        .createQueryBuilder('version')
        .innerJoin('document', 'document', 'document.id = version.document_id')
        .select('version.sourceObjectKey', 'sourceObjectKey')
        .addSelect('version.markdownObjectKey', 'markdownObjectKey')
        .where('document.purged_at IS NULL')
        .getRawMany<{ sourceObjectKey: string; markdownObjectKey: string | null }>();
      const assetRows = await this.dataSource
        .getRepository(DocumentAssetEntity)
        .createQueryBuilder('asset')
        .innerJoin('document_version', 'version', 'version.id = asset.document_version_id')
        .innerJoin('document', 'document', 'document.id = version.document_id')
        .select('asset.objectKey', 'objectKey')
        .where('document.purged_at IS NULL')
        .getRawMany<{ objectKey: string }>();
      const referenced = new Set<string>();
      for (const row of versionRows) {
        referenced.add(row.sourceObjectKey);
        if (row.markdownObjectKey) referenced.add(row.markdownObjectKey);
      }
      for (const row of assetRows) referenced.add(row.objectKey);

      const cutoff =
        Date.now() - this.config.getOrThrow('ORPHAN_OBJECT_GRACE_HOURS') * 60 * 60 * 1_000;
      const objects = await this.storage.listObjects('tenants/');
      const orphans = objects.filter(
        (object) =>
          !referenced.has(object.key) &&
          object.lastModified !== null &&
          object.lastModified.getTime() < cutoff,
      );
      await Promise.all(orphans.map((object) => this.storage.deleteObject(object.key)));
      if (orphans.length > 0) logEvent('object_storage.orphans_deleted', { count: orphans.length });
      return orphans.length;
    } finally {
      this.running = false;
    }
  }
}
