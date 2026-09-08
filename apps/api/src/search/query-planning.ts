import type { SearchQuerySource } from '@knowledge-base/contracts';

export type QueryIntent = 'exact' | 'fact' | 'comparison' | 'analysis';
export type QueryVariantKind = 'original' | 'normalized' | 'keyword' | 'subquery' | 'exact';
export const QUERY_PLANNER_VERSION = 'query-planner-v1';

export type QueryVariant = {
  text: string;
  kind: QueryVariantKind;
  weight: number;
  useVector: boolean;
};

export type RetrievalQueryPlan = {
  version: typeof QUERY_PLANNER_VERSION;
  enabled: boolean;
  intent: QueryIntent;
  variants: QueryVariant[];
  baseCandidateLimit: number;
  candidateLimit: number;
  requestedResultLimit: number;
  resultLimit: number;
  keywordWeight: number;
  vectorWeight: number;
};

export function planRetrievalQuery(
  text: string,
  options: {
    baseCandidateLimit: number;
    requestedResultLimit: number;
    source?: SearchQuerySource;
    enabled?: boolean;
  },
): RetrievalQueryPlan {
  const original = normalizeWhitespace(text);
  const normalized = rewriteQuestion(original);
  const exactTerms = extractExactTerms(original);
  const comparisonSubjects = extractComparisonSubjects(normalized);
  const intent = classifyQuery(original, comparisonSubjects, exactTerms);
  const variants: QueryVariant[] = [];
  addVariant(variants, {
    text: original,
    kind: 'original',
    weight: 1,
    useVector: true,
  });
  const enabled = options.enabled !== false;
  const baseCandidateLimit = clamp(Math.round(options.baseCandidateLimit), 20, 500);
  const requestedResultLimit = clamp(Math.round(options.requestedResultLimit), 1, 50);
  if (!enabled) {
    return {
      version: QUERY_PLANNER_VERSION,
      enabled: false,
      intent,
      variants,
      baseCandidateLimit,
      candidateLimit: baseCandidateLimit,
      requestedResultLimit,
      resultLimit: requestedResultLimit,
      keywordWeight: 1,
      vectorWeight: 1,
    };
  }
  if (normalized !== original) {
    addVariant(variants, {
      text: normalized,
      kind: 'normalized',
      weight: 0.95,
      useVector: true,
    });
  }

  if (intent === 'comparison') {
    for (const subject of comparisonSubjects.slice(0, 2)) {
      addVariant(variants, {
        text: subject,
        kind: 'subquery',
        weight: 0.85,
        useVector: true,
      });
    }
  } else if (intent === 'exact') {
    for (const term of exactTerms.slice(0, 2)) {
      addVariant(variants, {
        text: term,
        kind: 'exact',
        weight: 1.1,
        useVector: false,
      });
    }
  } else {
    const keywordQuery = keywordFocusedQuery(normalized);
    if (keywordQuery !== normalized) {
      addVariant(variants, {
        text: keywordQuery,
        kind: 'keyword',
        weight: 0.85,
        useVector: false,
      });
    }
  }

  const candidateFactors: Record<QueryIntent, number> = {
    exact: 0.6,
    fact: 1,
    comparison: 1.5,
    analysis: 1.75,
  };
  const candidateLimit = clamp(Math.round(baseCandidateLimit * candidateFactors[intent]), 20, 500);
  const resultLimit =
    options.source === 'answer'
      ? Math.min(
          requestedResultLimit,
          intent === 'exact' ? 3 : intent === 'fact' ? 5 : requestedResultLimit,
        )
      : requestedResultLimit;
  const channelWeights: Record<QueryIntent, { keyword: number; vector: number }> = {
    exact: { keyword: 1.5, vector: 0.7 },
    fact: { keyword: 1, vector: 1.1 },
    comparison: { keyword: 1, vector: 1.2 },
    analysis: { keyword: 0.9, vector: 1.3 },
  };

  return {
    version: QUERY_PLANNER_VERSION,
    enabled: true,
    intent,
    variants: variants.slice(0, 4),
    baseCandidateLimit,
    candidateLimit,
    requestedResultLimit,
    resultLimit,
    keywordWeight: channelWeights[intent].keyword,
    vectorWeight: channelWeights[intent].vector,
  };
}

function classifyQuery(
  text: string,
  comparisonSubjects: string[],
  exactTerms: string[],
): QueryIntent {
  if (comparisonSubjects.length >= 2) return 'comparison';
  if (exactTerms.length > 0) return 'exact';
  if (
    text.length >= 80 ||
    /(分析|原因|影响|趋势|总结|归纳|综合|多方面|分别说明|为什么|how does|analy[sz]e|compare the impact|summari[sz]e)/iu.test(
      text,
    ) ||
    (text.match(/[?？]/gu)?.length ?? 0) > 1
  ) {
    return 'analysis';
  }
  return 'fact';
}

function rewriteQuestion(text: string): string {
  return normalizeWhitespace(
    text
      .replace(
        /^(?:请问|请帮我|麻烦(?:帮我)?|帮我(?:查找|查|找|看看|了解)?|我想(?:知道|了解)|please|could you|can you)\s*/iu,
        '',
      )
      .replace(/(?:咋办|怎么办)/gu, '处理方案')
      .replace(/(?:咋样|怎样|怎么)/gu, '如何')
      .replace(/[?？]+\s*$/u, ''),
  );
}

function keywordFocusedQuery(text: string): string {
  return normalizeWhitespace(
    text
      .replace(
        /^(?:什么是|如何|为什么|是否|哪些|哪里|何时|谁|what is|how to|why is|which)\s*/iu,
        '',
      )
      .replace(/(?:是什么|有哪些|如何处理|如何操作|吗|呢)\s*$/iu, '')
      .replace(/[?？]/gu, ' '),
  );
}

function extractExactTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/["“”']([^"“”']{2,80})["“”']/gu)) {
    if (match[1]) terms.push(match[1].trim());
  }
  for (const match of text.matchAll(
    /\b(?:[A-Z]{2,}[A-Z0-9._/-]*|[A-Za-z0-9_-]+\.(?:pdf|docx?|xlsx?|pptx?|md|txt)|[A-Za-z]+-\d{2,})\b/gu,
  )) {
    terms.push(match[0]);
  }
  return unique(terms);
}

function extractComparisonSubjects(text: string): string[] {
  if (!/(区别|差异|不同|对比|比较|优缺点|vs\.?|versus|difference|compare)/iu.test(text)) {
    return [];
  }
  const cleaned = text
    .replace(/^(?:请)?(?:比较|对比|分析)\s*/u, '')
    .replace(/(?:之间)?(?:的)?(?:区别|差异|不同|对比|比较|优缺点)(?:是什么|有哪些|如何)?\s*$/u, '')
    .replace(/(?:what is|what are)?\s*the\s*differences?\s*between\s*/iu, '')
    .replace(/\s*(?:differences?|compare)\s*$/iu, '');
  const parts = cleaned
    .split(/\s*(?:和|与|跟|及|以及|vs\.?|versus|and)\s*/iu)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2 && part.length <= 100);
  return unique(parts).slice(0, 2);
}

function addVariant(variants: QueryVariant[], variant: QueryVariant): void {
  if (
    !variant.text ||
    variants.some((item) => item.text.toLocaleLowerCase() === variant.text.toLocaleLowerCase())
  ) {
    return;
  }
  variants.push(variant);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, ' ').trim();
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLocaleLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
