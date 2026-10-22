import os from "node:os";
import { fileURLToPath } from "node:url";
import { Piscina } from "piscina";
import type { ExtractedFile } from "./extract-file.js";
import type { ParseTask } from "./parse-worker.js";

export interface ParsePoolOptions {
  /** Worker threads. Default: one per core, minus one for the main thread. */
  readonly threads?: number;
  /**
   * The parse-worker module. Default: the one next to this file. A bundle
   * (the desktop app) passes its own copy.
   */
  readonly workerFile?: string | URL;
  /** Smallest number of files worth the pool; fewer parse in-process. */
  readonly minBatch?: number;
  /** Files per worker task (fewer messages, coarser progress). */
  readonly batchSize?: number;
}

/**
 * Smallest number of cache misses sent to the pool by default. Below it,
 * starting workers (each loads the WASM runtime and its grammars) costs about
 * what it saves. Measured in M3 on the first N vitest files, 4 cores, 3
 * workers, start-up included (median of 3): 256 files took 440 ms in-process
 * and 457 ms pooled; 512 files 835 ms and 633 ms.
 */
export const DEFAULT_MIN_BATCH = 256;

/**
 * Files per worker task by default. Measured in M3 on all 2,400 vitest files
 * with 3 workers: 1 file per task 1,151 ms, 8 files 880 ms, 32 files 820 ms,
 * 128 files 833 ms.
 */
export const DEFAULT_BATCH_SIZE = 32;

/**
 * A piscina pool of parse workers (CLAUDE.md "Architecture": worker threads in
 * the analysis host, and in the CLI). Threads start on first use and exit
 * when idle, so a warm run that parses nothing starts none.
 */
export class ParsePool {
  readonly threads: number;
  readonly minBatch: number;
  readonly batchSize: number;
  private readonly filename: string;
  private piscina: Piscina<ParseTask, ExtractedFile[]> | undefined;
  /** Set once a worker fails outside a task (e.g. its module will not load). */
  private failure: Error | undefined;
  private readonly inFlight = new Set<(error: Error) => void>();

  constructor(options: ParsePoolOptions = {}) {
    this.threads = Math.max(
      1,
      options.threads ?? os.availableParallelism() - 1,
    );
    this.minBatch = options.minBatch ?? DEFAULT_MIN_BATCH;
    this.batchSize = Math.max(1, options.batchSize ?? DEFAULT_BATCH_SIZE);
    const file =
      options.workerFile ?? new URL("./parse-worker.js", import.meta.url);
    this.filename = file instanceof URL ? fileURLToPath(file) : file;
  }

  /** Whether any worker has been started. */
  get started(): boolean {
    return this.piscina !== undefined;
  }

  /** Parses one batch; results come back in the batch's order. */
  run(task: ParseTask): Promise<ExtractedFile[]> {
    if (this.failure !== undefined) return Promise.reject(this.failure);
    const piscina = this.start();
    return new Promise<ExtractedFile[]>((resolve, reject) => {
      this.inFlight.add(reject);
      piscina
        .run(task)
        .then(resolve, reject)
        .finally(() => this.inFlight.delete(reject));
    });
  }

  private start(): Piscina<ParseTask, ExtractedFile[]> {
    if (this.piscina === undefined) {
      const piscina = new Piscina<ParseTask, ExtractedFile[]>({
        filename: this.filename,
        minThreads: 0,
        maxThreads: this.threads,
        idleTimeout: 30_000,
      });
      // A worker that dies outside a task would otherwise leave its tasks
      // pending forever: fail them, and every later run, instead.
      piscina.on("error", (error: unknown) => {
        this.failure =
          error instanceof Error ? error : new Error(String(error));
        for (const reject of this.inFlight) reject(this.failure);
        this.inFlight.clear();
      });
      this.piscina = piscina;
    }
    return this.piscina;
  }

  async destroy(): Promise<void> {
    const p = this.piscina;
    this.piscina = undefined;
    await p?.destroy();
  }
}
