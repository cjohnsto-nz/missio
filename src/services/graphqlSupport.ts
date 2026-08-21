import type {
  GraphQLBody,
  GraphQLBodyVariant,
  GraphQLRequest,
  GraphQLRequestDetails,
  HttpRequest,
} from '../models/types';

export interface SelectedGraphQLBody {
  body?: GraphQLBody;
  index?: number;
}

export class InvalidGraphQLVariablesError extends Error {
  public readonly code = 'MISSIO_INVALID_GRAPHQL_VARIABLES';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidGraphQLVariablesError';
  }
}

function cloneJson<T>(value: T): T {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function selectGraphQLBody(body: GraphQLRequestDetails['body']): SelectedGraphQLBody {
  if (!body) return {};
  if (!Array.isArray(body)) return { body };

  const selectedIndex = body.findIndex(variant => variant.selected === true);
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  const variant = body[index] as GraphQLBodyVariant | undefined;
  return { body: variant?.body, index };
}

export function getGraphQLOperationType(query: string | undefined): 'query' | 'mutation' | 'subscription' | undefined {
  if (!query) return undefined;

  const withoutComments = query
    .split(/\r?\n/)
    .map(line => line.replace(/#.*/, ''))
    .join('\n')
    .trim();

  const match = withoutComments.match(/^(query|mutation|subscription)\b/i);
  if (!match) return undefined;
  return match[1].toLowerCase() as 'query' | 'mutation' | 'subscription';
}

export function describeGraphQLOperation(request: GraphQLRequest): string {
  const selected = selectGraphQLBody(request.graphql?.body);
  const operation = getGraphQLOperationType(selected.body?.query);
  return operation ? operation.toUpperCase() : (request.graphql?.method ?? 'POST').toUpperCase();
}

export function buildGraphQLRequestBodyData(body: GraphQLBody | undefined): string {
  const query = body?.query ?? '';
  const rawVariables = body?.variables?.trim();
  let variables = '{}';

  if (rawVariables) {
    try {
      JSON.parse(rawVariables);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InvalidGraphQLVariablesError(`GraphQL variables must be valid JSON: ${message}`);
    }
    variables = rawVariables;
  }

  return `{"query":${JSON.stringify(query)},"variables":${variables}}`;
}

export function buildGraphQLHttpRequest(request: GraphQLRequest): HttpRequest {
  const details = request.graphql ?? {};
  const selected = selectGraphQLBody(details.body);
  const method = (details.method ?? 'POST').toUpperCase();
  const bodyData = buildGraphQLRequestBodyData(selected.body);
  const params = cloneJson(details.params ?? []);

  if (method === 'GET') {
    const setGraphQLParam = (name: string, value: string): void => {
      const existing = params.find(param => !param.disabled && param.name.toLowerCase() === name);
      if (existing) existing.value = value;
      else params.push({ name, value, type: 'query' });
    };

    setGraphQLParam('query', selected.body?.query ?? '');
    setGraphQLParam('variables', selected.body?.variables?.trim() || '{}');
  }

  return {
    info: {
      name: request.info?.name,
      description: cloneJson(request.info?.description),
      tags: cloneJson(request.info?.tags),
      type: 'http',
    },
    http: {
      method,
      url: details.url ?? '',
      headers: cloneJson(details.headers ?? []),
      params,
      body: method === 'GET' ? undefined : {
        type: 'json',
        data: bodyData,
      },
    },
    runtime: cloneJson(request.runtime),
    settings: cloneJson(request.settings),
    docs: request.docs,
  };
}
