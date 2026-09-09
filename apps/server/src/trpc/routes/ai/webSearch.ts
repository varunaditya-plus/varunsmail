import { getWebSearchOptions } from '../../../lib/ai-model';
import { env } from '../../../env';
import { activeDriverProcedure } from '../../trpc';
import { generateText } from 'ai';
import { z } from 'zod';

export async function researchWeb(query: string) {
  return generateText({
    ...getWebSearchOptions(env),
    system:
      'Search the web and answer concisely. Include inline links to the sources supporting your answer.',
    messages: [{ role: 'user', content: query }],
    maxTokens: 1024,
  });
}

export const webSearch = activeDriverProcedure
  .input(z.object({ query: z.string() }))
  .mutation(async ({ input }) => researchWeb(input.query));
