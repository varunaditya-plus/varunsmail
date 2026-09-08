import { LoggingService } from './logging-service';
import { getContext } from 'hono/context-storage';
import type { HonoContext } from '../ctx';

export interface LoggingContext {
  sessionId: string;
  userId?: string;
}

export const createLoggingMiddleware = () => {
  return async (opts: {
    path: string;
    type: 'query' | 'mutation' | 'subscription';
    next: () => Promise<any>;
    input: any;
    ctx: any;
  }) => {
    const startTime = Date.now();
    let finishLogging: ((failed: boolean) => Promise<void>) | undefined;

    try {
      const c = getContext<HonoContext>();
      const userId = c.var.sessionUser?.id;
      const loggingService = userId ? new LoggingService(c.env) : undefined;
      if (userId) loggingService?.initializeSession(userId, userId);

      const { addRequestSpan, completeRequestSpan, getRequestTrace, TraceContext } = await import(
        './trace-context'
      );
      const procedureSpan = addRequestSpan(
        c,
        'trpc_procedure_execution',
        { procedure: opts.path, type: opts.type },
        { 'trpc.procedure': opts.path, 'trpc.type': opts.type },
      );

      finishLogging = async (failed) => {
        if (procedureSpan) {
          completeRequestSpan(
            c,
            procedureSpan.id,
            { success: !failed },
            failed ? 'Procedure failed' : undefined,
          );
        }

        const trace = getRequestTrace(c);
        if (userId && loggingService) {
          await loggingService.logCall({
            sessionId: userId,
            userId,
            procedure: opts.path,
            input: undefined,
            error: failed ? 'Procedure failed' : undefined,
            duration: Date.now() - startTime,
            metadata: {
              method: opts.type,
              requestId: c.req.header('X-Request-Id'),
              traceId: trace?.traceId,
            },
          });
        }
        if (trace) TraceContext.completeTrace(trace.traceId);
      };
    } catch {
      console.warn('Request logging unavailable');
    }

    const record = async (failed: boolean) => {
      try {
        await finishLogging?.(failed);
      } catch {
        console.warn('Request logging unavailable');
      }
    };

    let output;
    try {
      output = await opts.next();
    } catch (error) {
      await record(true);
      throw error;
    }

    await record(false);
    return output;
  };
};
