import { getWebSearchOptions } from '../../../lib/ai-model';
import { env } from '../../../env';
import { activeDriverProcedure } from '../../trpc';
import { generateText } from 'ai';
import { z } from 'zod';

export const webSearch = activeDriverProcedure
  .input(z.object({ query: z.string() }))
  .mutation(async ({ input }) => {
    const result = await generateText({
      ...getWebSearchOptions(env),
      system:
        'Search the web and answer concisely. Include inline links to the sources supporting your answer.',
      messages: [{ role: 'user', content: input.query }],
      maxTokens: 1024,
    });
    return result;
  });
