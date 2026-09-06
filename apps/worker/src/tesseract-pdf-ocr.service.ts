import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ServerEnv } from '@knowledge-base/config';
import type { BoundingBox, PdfOcrEngine, PdfOcrInput, PdfOcrResult } from '@knowledge-base/rag';
import { mkdir } from 'node:fs/promises';
import { createWorker, OEM, type Worker } from 'tesseract.js';

@Injectable()
export class TesseractPdfOcrService implements PdfOcrEngine, OnModuleDestroy {
  private workerPromise: Promise<Worker> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(@Inject(ConfigService) private readonly config: ConfigService<ServerEnv, true>) {}

  get enabled(): boolean {
    return this.config.getOrThrow('PDF_OCR_PROVIDER') === 'tesseract';
  }

  recognize(input: PdfOcrInput): Promise<PdfOcrResult> {
    const task = this.queue.then(() => this.runRecognition(input));
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  async onModuleDestroy(): Promise<void> {
    if (!this.workerPromise) return;
    const worker = await this.workerPromise.catch(() => null);
    this.workerPromise = null;
    if (worker) await worker.terminate();
  }

  private async runRecognition(input: PdfOcrInput): Promise<PdfOcrResult> {
    if (!this.enabled) throw new Error('Tesseract PDF OCR is disabled');
    const worker = await this.worker();
    const result = await worker.recognize(
      Buffer.from(input.image),
      {},
      { text: true, blocks: true },
      `pdf-page-${input.page}`,
    );
    return {
      text: result.data.text.trim(),
      confidence: result.data.confidence,
      blocks: (result.data.blocks ?? [])
        .flatMap((block) => block.paragraphs)
        .filter((paragraph) => paragraph.text.trim())
        .map((paragraph) => ({
          text: paragraph.text.trim(),
          confidence: paragraph.confidence,
          bbox: normalizeBox(paragraph.bbox, input.width, input.height),
        })),
    };
  }

  private async worker(): Promise<Worker> {
    if (!this.workerPromise) {
      const languages = this.config
        .getOrThrow('PDF_OCR_LANGUAGES')
        .split(/[,+]/u)
        .map((language: string) => language.trim())
        .filter(Boolean);
      const langPath = this.config.get('PDF_OCR_LANG_PATH');
      const cachePath = this.config.getOrThrow('PDF_OCR_CACHE_PATH');
      await mkdir(cachePath, { recursive: true });
      this.workerPromise = createWorker(languages, OEM.LSTM_ONLY, {
        cachePath,
        ...(langPath ? { langPath } : {}),
      }).catch((error) => {
        this.workerPromise = null;
        throw error;
      });
    }
    return this.workerPromise;
  }
}

function normalizeBox(
  box: { x0: number; y0: number; x1: number; y1: number },
  width: number,
  height: number,
): BoundingBox {
  return {
    x: clamp(box.x0 / Math.max(1, width)),
    y: clamp(box.y0 / Math.max(1, height)),
    width: clamp((box.x1 - box.x0) / Math.max(1, width)),
    height: clamp((box.y1 - box.y0) / Math.max(1, height)),
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
