import {
  AcquireReadableStreamDefaultReader,
  isAbortSignal,
  IsReadableStream,
  IsReadableStreamLocked,
  ReadableStream,
  ReadableStreamCancel,
  ReadableStreamDefaultReaderRead,
  ReadableStreamReaderGenericRelease
} from '../readable-stream';
import {
  AcquireWritableStreamDefaultWriter,
  IsWritableStream,
  IsWritableStreamLocked,
  WritableStream,
  WritableStreamAbort,
  WritableStreamCloseQueuedOrInFlight,
  WritableStreamDefaultWriterCloseWithErrorPropagation,
  WritableStreamDefaultWriterRelease,
  WritableStreamDefaultWriterWrite
} from '../writable-stream';
import assert from '../../stub/assert';
import { WaitForAllPromise } from '../helpers';
import { rethrowAssertionErrorRejection } from '../utils';

export function ReadableStreamPipeTo<T>(source: ReadableStream<T>,
                                        dest: WritableStream<T>,
                                        preventClose: boolean,
                                        preventAbort: boolean,
                                        preventCancel: boolean,
                                        signal: AbortSignal | undefined): Promise<void> {
  assert(IsReadableStream(source) === true);
  assert(IsWritableStream(dest) === true);
  assert(typeof preventClose === 'boolean');
  assert(typeof preventAbort === 'boolean');
  assert(typeof preventCancel === 'boolean');
  assert(signal === undefined || isAbortSignal(signal));
  assert(IsReadableStreamLocked(source) === false);
  assert(IsWritableStreamLocked(dest) === false);

  const reader = AcquireReadableStreamDefaultReader<T>(source);
  const writer = AcquireWritableStreamDefaultWriter<T>(dest);

  let shuttingDown = false;

  // This is used to keep track of the spec's requirement that we wait for ongoing writes during shutdown.
  let currentWrite = Promise.resolve();

  return new Promise((resolve, reject) => {
    let abortAlgorithm: () => void;
    if (signal !== undefined) {
      abortAlgorithm = () => {
        const error = new DOMException('Aborted', 'AbortError');
        const actions: Array<() => Promise<void>> = [];
        if (preventAbort === false) {
          actions.push(() => {
            if (dest._state === 'writable') {
              return WritableStreamAbort(dest, error);
            }
            return Promise.resolve();
          });
        }
        if (preventCancel === false) {
          actions.push(() => {
            if (source._state === 'readable') {
              return ReadableStreamCancel(source, error);
            }
            return Promise.resolve();
          });
        }
        shutdownWithAction(() => WaitForAllPromise(actions.map(action => action()), results => results), true, error);
      };

      if (signal.aborted === true) {
        abortAlgorithm();
        return;
      }

      signal.addEventListener('abort', abortAlgorithm);
    }

    // Using reader and writer, read all chunks from this and write them to dest
    // - Backpressure must be enforced
    // - Shutdown must stop all activity
    function pipeLoop() {
      return new Promise<void>((resolveLoop, rejectLoop) => {
        function next(done: boolean) {
          if (done) {
            resolveLoop();
          } else {
            pipeStep().then(next, rejectLoop);
          }
        }

        next(false);
      });
    }

    function pipeStep(): Promise<boolean> {
      if (shuttingDown === true) {
        return Promise.resolve(true);
      }

      return writer._readyPromise.then(() => {
        return ReadableStreamDefaultReaderRead(reader).then(({ value, done }) => {
          if (done === true) {
            return true;
          }

          currentWrite = WritableStreamDefaultWriterWrite(writer, value!).catch(() => {});
          return false;
        });
      });
    }

    // Errors must be propagated forward
    isOrBecomesErrored(source, reader._closedPromise, storedError => {
      if (preventAbort === false) {
        shutdownWithAction(() => WritableStreamAbort(dest, storedError), true, storedError);
      } else {
        shutdown(true, storedError);
      }
    });

    // Errors must be propagated backward
    isOrBecomesErrored(dest, writer._closedPromise, storedError => {
      if (preventCancel === false) {
        shutdownWithAction(() => ReadableStreamCancel(source, storedError), true, storedError);
      } else {
        shutdown(true, storedError);
      }
    });

    // Closing must be propagated forward
    isOrBecomesClosed(source, reader._closedPromise, () => {
      if (preventClose === false) {
        shutdownWithAction(() => WritableStreamDefaultWriterCloseWithErrorPropagation(writer));
      } else {
        shutdown();
      }
    });

    // Closing must be propagated backward
    if (WritableStreamCloseQueuedOrInFlight(dest) === true || dest._state === 'closed') {
      const destClosed = new TypeError('the destination writable stream closed before all data could be piped to it');

      if (preventCancel === false) {
        shutdownWithAction(() => ReadableStreamCancel(source, destClosed), true, destClosed);
      } else {
        shutdown(true, destClosed);
      }
    }

    pipeLoop().catch(rethrowAssertionErrorRejection);

    function waitForWritesToFinish(): Promise<void> {
      // Another write may have started while we were waiting on this currentWrite, so we have to be sure to wait
      // for that too.
      const oldCurrentWrite = currentWrite;
      return currentWrite.then(() => oldCurrentWrite !== currentWrite ? waitForWritesToFinish() : undefined);
    }

    function isOrBecomesErrored(stream: ReadableStream | WritableStream,
                                promise: Promise<void>,
                                action: (reason: any) => void) {
      if (stream._state === 'errored') {
        action(stream._storedError);
      } else {
        promise.catch(action).catch(rethrowAssertionErrorRejection);
      }
    }

    function isOrBecomesClosed(stream: ReadableStream | WritableStream, promise: Promise<void>, action: () => void) {
      if (stream._state === 'closed') {
        action();
      } else {
        promise.then(action).catch(rethrowAssertionErrorRejection);
      }
    }

    function shutdownWithAction(action: () => Promise<unknown>, originalIsError?: boolean, originalError?: any) {
      if (shuttingDown === true) {
        return;
      }
      shuttingDown = true;

      if (dest._state === 'writable' && WritableStreamCloseQueuedOrInFlight(dest) === false) {
        waitForWritesToFinish().then(doTheRest);
      } else {
        doTheRest();
      }

      function doTheRest() {
        action().then(
          () => finalize(originalIsError, originalError),
          newError => finalize(true, newError)
        ).catch(rethrowAssertionErrorRejection);
      }
    }

    function shutdown(isError?: boolean, error?: any) {
      if (shuttingDown === true) {
        return;
      }
      shuttingDown = true;

      if (dest._state === 'writable' && WritableStreamCloseQueuedOrInFlight(dest) === false) {
        waitForWritesToFinish().then(() => finalize(isError, error)).catch(rethrowAssertionErrorRejection);
      } else {
        finalize(isError, error);
      }
    }

    function finalize(isError?: boolean, error?: any) {
      WritableStreamDefaultWriterRelease(writer);
      ReadableStreamReaderGenericRelease(reader);

      if (signal !== undefined) {
        signal.removeEventListener('abort', abortAlgorithm);
      }
      if (isError) {
        reject(error);
      } else {
        resolve(undefined);
      }
    }
  });
}
