BEGIN;

UPDATE ingestion_job
SET status = 'queued',
    progress = 0,
    queue_job_id = NULL,
    updated_at = now()
WHERE status IN ('queued', 'active');

UPDATE outbox_event event
SET status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    locked_at = NULL,
    published_at = NULL,
    last_error = 'Redis queue state reconciled after restore',
    updated_at = now()
FROM ingestion_job job
WHERE event.event_type = 'document.ingestion.requested'
  AND event.status <> 'cancelled'
  AND event.payload ->> 'documentVersionId' = job.document_version_id::text
  AND job.status = 'queued';

UPDATE outbox_event event
SET status = 'pending',
    attempts = 0,
    next_attempt_at = now(),
    locked_at = NULL,
    published_at = NULL,
    last_error = 'Redis cleanup queue state reconciled after restore',
    updated_at = now()
FROM document
WHERE event.event_type = 'document.cleanup.requested'
  AND event.status <> 'cancelled'
  AND event.payload ->> 'documentId' = document.id::text
  AND document.deleted_at IS NOT NULL
  AND document.purged_at IS NULL;

COMMIT;
