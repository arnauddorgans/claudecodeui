import { open } from 'node:fs/promises';

import { providerRuntimeService } from '@/modules/providers/services/provider-runtime.service.js';
import type {
  SessionTaskOutputChunk,
  SessionTaskOutputEncoding,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** What one call returns when the caller asks for no size. */
export const TASK_OUTPUT_DEFAULT_LIMIT = 64 * 1024;

/**
 * The most one call returns. A build log is tens of megabytes; past this the
 * answer is cut and `truncated` says so, with `nextOffset` naming where to
 * carry on.
 */
export const TASK_OUTPUT_MAX_LIMIT = 1024 * 1024;

/**
 * The least one call returns. Text answers are trimmed back to a whole UTF-8
 * character, which costs at most three bytes; a window this size can never be
 * trimmed down to nothing.
 */
export const TASK_OUTPUT_MIN_LIMIT = 1024;

export type ReadTaskOutputOptions = {
  /** Byte offset to read from. Mutually exclusive with `tail`. */
  offset?: number;
  /** Read the last N bytes instead, for a log whose interesting part is its end. */
  tail?: number;
  limit?: number;
  encoding?: SessionTaskOutputEncoding;
};

/**
 * The index one past the last byte of the last whole UTF-8 character in
 * `buffer[0, length)`. A window addressed by byte offset lands anywhere,
 * including inside a multi-byte character; cutting there and decoding would
 * hand the client a replacement character for something the next window
 * completes. At most three bytes are held back, and only when the sequence
 * they start is not whole.
 */
function endOfWholeCharacters(buffer: Buffer, length: number): number {
  for (let back = 1; back <= 3 && back <= length; back += 1) {
    const byte = buffer[length - back];
    if ((byte & 0b1100_0000) !== 0b1000_0000) {
      // A lead byte (or a plain ASCII one): how many bytes its character takes.
      const expected = (byte & 0b1000_0000) === 0 ? 1
        : (byte & 0b1110_0000) === 0b1100_0000 ? 2
          : (byte & 0b1111_0000) === 0b1110_0000 ? 3
            : (byte & 0b1111_1000) === 0b1111_0000 ? 4
              : 1;
      return expected <= back ? length : length - back;
    }
  }
  return length;
}

/** The first byte of a whole UTF-8 character at or after `start`, at most three bytes on. */
function startOfWholeCharacter(buffer: Buffer, length: number): number {
  for (let forward = 0; forward < 3 && forward < length; forward += 1) {
    if ((buffer[forward] & 0b1100_0000) !== 0b1000_0000) {
      return forward;
    }
  }
  return 0;
}

/**
 * Reads one window of the output file of a task of a session's process.
 *
 * The file is never named by the caller: the session id and the task id are
 * resolved against the process's own record of that task
 * (`IProviderRuntime.describeTask`), so the route cannot be pointed at
 * anything else. Everything it can answer is an error of its own: a session
 * with no live process, a task the process never reported, a task whose file
 * nothing can name yet, a file that is gone, a file that will not open.
 */
export const sessionTaskOutputService = {
  async readTaskOutput(
    sessionId: string,
    taskId: string,
    options: ReadTaskOutputOptions = {},
  ): Promise<SessionTaskOutputChunk> {
    if (!providerRuntimeService.getSessionProcess(sessionId)) {
      throw new AppError(
        `Session "${sessionId}" has no running process; a task's output is readable while its process lives.`,
        { code: 'SESSION_PROCESS_NOT_RUNNING', statusCode: 409 },
      );
    }

    const target = providerRuntimeService.describeSessionTask(sessionId, taskId);
    if (!target) {
      throw new AppError(`Session "${sessionId}" has no task "${taskId}".`, {
        code: 'TASK_NOT_FOUND',
        statusCode: 404,
      });
    }
    if (!target.outputFile || !target.outputFileSource) {
      throw new AppError(`Task "${taskId}" has no output file its process can name.`, {
        code: 'TASK_OUTPUT_UNKNOWN',
        statusCode: 409,
      });
    }

    const encoding: SessionTaskOutputEncoding = options.encoding ?? 'text';
    const limit = Math.min(
      Math.max(options.limit ?? TASK_OUTPUT_DEFAULT_LIMIT, TASK_OUTPUT_MIN_LIMIT),
      TASK_OUTPUT_MAX_LIMIT,
    );

    const handle = await open(target.outputFile, 'r').catch((error: NodeJS.ErrnoException) => {
      if (error?.code === 'ENOENT') {
        throw new AppError(`Task "${taskId}" has written no output file yet.`, {
          code: 'TASK_OUTPUT_NOT_FOUND',
          statusCode: 404,
        });
      }
      throw new AppError(`Task "${taskId}" has an output file that cannot be read.`, {
        code: 'TASK_OUTPUT_UNREADABLE',
        statusCode: 403,
      });
    });

    try {
      const stats = await handle.stat();
      // A directory opens as happily as a file on macOS and only fails on the
      // read; an honest error beats a 500 from deeper down.
      if (!stats.isFile()) {
        throw new AppError(`Task "${taskId}" has an output file that cannot be read.`, {
          code: 'TASK_OUTPUT_UNREADABLE',
          statusCode: 403,
        });
      }
      const { size } = stats;
      // A file that was rotated under a client reading it comes back shorter
      // than the offset it asked for: it is told where the end is now rather
      // than an offset it can never reach.
      const start = options.tail === undefined
        ? Math.min(Math.max(options.offset ?? 0, 0), size)
        : Math.max(size - Math.min(Math.max(options.tail, 0), TASK_OUTPUT_MAX_LIMIT), 0);
      const available = Math.max(size - start, 0);
      const length = Math.min(limit, available);
      const buffer = Buffer.alloc(length);
      const { bytesRead } = length > 0
        ? await handle.read(buffer, 0, length, start).catch(() => {
          throw new AppError(`Task "${taskId}" has an output file that cannot be read.`, {
            code: 'TASK_OUTPUT_UNREADABLE',
            statusCode: 403,
          });
        })
        : { bytesRead: 0 };

      let from = 0;
      let to = bytesRead;
      if (encoding === 'text' && bytesRead > 0) {
        // Only a window that starts mid-file can start mid-character.
        from = start > 0 ? startOfWholeCharacter(buffer, bytesRead) : 0;
        to = endOfWholeCharacters(buffer, bytesRead);
        if (to <= from) {
          to = bytesRead;
        }
      }
      const content = buffer.subarray(from, to).toString(encoding === 'base64' ? 'base64' : 'utf8');

      return {
        sessionId,
        taskId: target.taskId,
        status: target.status,
        running: target.running,
        outputFileSource: target.outputFileSource,
        encoding,
        content,
        offset: start + from,
        nextOffset: start + to,
        bytesRead: to - from,
        size,
        truncated: available > length,
      };
    } finally {
      await handle.close();
    }
  },
};
