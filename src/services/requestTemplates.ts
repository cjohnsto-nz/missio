import type { OpenCollectionRequest, RequestProtocol } from '../models/types';

export interface RequestProtocolChoice {
  protocol: RequestProtocol;
  label: string;
  description: string;
}

export const REQUEST_PROTOCOL_CHOICES: RequestProtocolChoice[] = [
  { protocol: 'http', label: 'HTTP', description: 'REST or HTTP API request' },
  { protocol: 'graphql', label: 'GraphQL', description: 'GraphQL query or mutation request' },
  { protocol: 'websocket', label: 'WebSocket', description: 'WebSocket connect and message request' },
  { protocol: 'grpc', label: 'gRPC', description: 'Unary gRPC request with protobuf configuration' },
];

export function requestProtocolLabel(protocol: RequestProtocol): string {
  return REQUEST_PROTOCOL_CHOICES.find(choice => choice.protocol === protocol)?.label ?? protocol.toUpperCase();
}

export function slugifyRequestName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'request';
}

export function createRequestTemplate(protocol: RequestProtocol, name: string, seq = 1): OpenCollectionRequest {
  switch (protocol) {
    case 'graphql':
      return {
        info: { name, type: 'graphql', seq },
        graphql: {
          method: 'POST',
          url: '{{baseUrl}}/graphql',
          body: {
            query: [
              'query Example {',
              '  health {',
              '    status',
              '  }',
              '}',
            ].join('\n'),
            variables: '{}',
          },
        },
        settings: {
          encodeUrl: true,
          timeout: 30000,
          followRedirects: true,
          maxRedirects: 5,
        },
      };
    case 'websocket':
      return {
        info: { name, type: 'websocket', seq },
        websocket: {
          url: '{{wsBaseUrl}}/ws/echo',
          message: {
            type: 'text',
            data: 'hello',
          },
        },
      };
    case 'grpc':
      return {
        info: { name, type: 'grpc', seq },
        grpc: {
          url: '{{grpcBaseUrl}}',
          method: 'package.Service/Method',
          methodType: 'unary',
          protoFilePath: 'proto/service.proto',
          message: '{}',
        },
      };
    case 'http':
    default:
      return {
        info: { name, type: 'http', seq },
        http: {
          method: 'GET',
          url: '{{baseUrl}}/',
        },
        settings: {
          encodeUrl: true,
          timeout: 30000,
          followRedirects: true,
          maxRedirects: 5,
        },
      };
  }
}
