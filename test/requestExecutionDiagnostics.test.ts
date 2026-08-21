import { describe, expect, it, vi } from 'vitest';
import type { MissioCollection } from '../src/models/types';
import { RequestCancelledError } from '../src/services/requestCancelledError';
import { RequestExecutionService } from '../src/services/requestExecutionService';

const collection = {
  id: 'diagnostics',
  filePath: 'opencollection.yml',
  rootDir: process.cwd(),
  data: {},
} as MissioCollection;

const httpClient = {
  send: vi.fn(),
  buildResolvedRequest: vi.fn(),
  cancelAll: vi.fn(),
} as any;

describe('request execution diagnostics', () => {
  it('rejects streaming gRPC runtime work before opening the transport', async () => {
    const grpcClient = { send: vi.fn(), cancelAll: vi.fn() };
    const runtime = { hasRuntimeWork: vi.fn().mockReturnValue(true) } as any;
    const execution = new RequestExecutionService(httpClient, undefined, grpcClient, runtime);

    await expect(execution.send({
      info: { name: 'Streaming runtime', type: 'grpc' },
      grpc: {
        url: 'localhost:50051',
        method: 'missio.demo.UserService/StreamUsers',
        methodType: 'server-streaming',
      },
      runtime: {
        scripts: [{ type: 'before-request', code: 'missio.variables.set("attempted", "yes");' }],
      },
    } as any, collection)).rejects.toMatchObject({
      code: 'MISSIO_UNSUPPORTED_PROTOCOL',
      diagnostic: {
        protocol: 'grpc',
        taskId: 'OC-080',
        message: expect.stringContaining('The streaming request was not sent.'),
      },
    });
    expect(grpcClient.send).not.toHaveBeenCalled();
  });

  it('recognizes typed cancellation independently of the message text', async () => {
    const cancellation = new RequestCancelledError('Stopped by caller');
    const webSocketClient = {
      send: vi.fn().mockRejectedValue(cancellation),
      cancelAll: vi.fn(),
      disconnect: vi.fn(),
    };
    const request = {
      info: { name: 'Typed cancellation', type: 'websocket' },
      websocket: { url: 'ws://localhost/hold' },
      runtime: { scripts: [{ type: 'before-request', code: 'console.log("prepared");' }] },
    } as any;
    const runtime = {
      hasRuntimeWork: vi.fn().mockReturnValue(true),
      prepareWebSocketRequest: vi.fn().mockResolvedValue({ request }),
      completeWebSocketRequest: vi.fn(),
    } as any;
    const execution = new RequestExecutionService(httpClient, webSocketClient, undefined, runtime);

    await expect(execution.send(request, collection)).rejects.toBe(cancellation);
    expect(runtime.completeWebSocketRequest).not.toHaveBeenCalled();
  });
});
