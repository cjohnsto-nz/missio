import { describe, expect, it } from 'vitest';
import { ResponseDocumentProvider } from '../src/providers/responseProvider';
import type { HttpResponse } from '../src/models/types';

describe('ResponseDocumentProvider runtime formatting', () => {
  it('prints runtime tests, assertions, actions, variable mutations, logs, and errors', () => {
    const provider = Object.create(ResponseDocumentProvider.prototype) as ResponseDocumentProvider;
    const response: HttpResponse = {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: '{"ok":true}',
      duration: 12,
      size: 11,
      runtime: {
        success: false,
        summary: { passed: 2, failed: 2, skipped: 1 },
        tests: [{ name: 'scripted test', passed: false, message: 'Expected false' }],
        assertions: [{ expression: 'res.status', operator: 'equals', expected: '201', actual: 200, passed: false }],
        actions: [{ type: 'set-variable', phase: 'after-response', target: 'runtime.token', value: 'abc', passed: true }],
        variableMutations: [{ scope: 'runtime', name: 'token', value: 'abc', source: 'action' }],
        logs: [{ phase: 'after-response', level: 'log', message: 'token abc' }],
        errors: [{ phase: 'before-request', message: 'require is not defined' }],
      },
    };

    const content = (provider as any)._formatResponse(response);

    expect(content).toContain('Runtime Results');
    expect(content).toContain('Success: no | Passed: 2 | Failed: 2 | Skipped: 1');
    expect(content).toContain('FAIL scripted test - Expected false');
    expect(content).toContain('FAIL res.status equals 201');
    expect(content).toContain('PASS after-response set-variable runtime.token');
    expect(content).toContain('runtime.token = abc');
    expect(content).toContain('[after-response] log: token abc');
    expect(content).toContain('[before-request] require is not defined');
  });

  it('prints gRPC streaming summaries and ordered events', () => {
    const provider = Object.create(ResponseDocumentProvider.prototype) as ResponseDocumentProvider;
    const response: HttpResponse = {
      status: 200,
      statusText: 'OK',
      headers: {
        'content-type': 'application/json',
        'x-missio-grpc-method': 'missio.demo.DemoService/ChatUsers',
        'x-missio-grpc-method-type': 'bidi-streaming',
      },
      body: '{"ok":true}',
      duration: 25,
      size: 11,
      stream: {
        protocol: 'grpc',
        method: 'missio.demo.DemoService/ChatUsers',
        methodType: 'bidi-streaming',
        sentMessageCount: 2,
        receivedMessageCount: 2,
        status: { code: 0, name: 'OK', details: 'OK' },
        metadata: { 'x-demo-grpc': 'ok', 'content-type': 'application/json' },
        events: [
          { type: 'sent', index: 0, description: 'first', elapsedMs: 1 },
          { type: 'received', index: 0, message: { name: 'ack:Ada' }, elapsedMs: 2 },
        ],
      },
    } as any;

    const content = (provider as any)._formatResponse(response);

    expect(content).toContain('gRPC Stream');
    expect(content).toContain('Type: bidi-streaming');
    expect(content).toContain('Sent: 2 | Received: 2');
    expect(content).toContain('x-demo-grpc: ok');
    expect(content).toContain('sent #1 first');
    expect(content).toContain('received #1: {"name":"ack:Ada"}');
  });

  it('prints runtime results for WebSocket response envelopes', () => {
    const provider = Object.create(ResponseDocumentProvider.prototype) as ResponseDocumentProvider;
    const response: HttpResponse = {
      status: 101,
      statusText: 'WebSocket Exchange',
      headers: {
        'content-type': 'application/json',
        'x-missio-protocol': 'websocket',
      },
      body: '{"protocol":"websocket","messageCount":1}',
      duration: 9,
      size: 41,
      runtime: {
        success: true,
        summary: { passed: 1, failed: 0, skipped: 0 },
        tests: [{ name: 'socket echoed', passed: true }],
        assertions: [],
        actions: [],
        variableMutations: [{ scope: 'runtime', name: 'socketToken', value: 'ok', source: 'script' }],
        logs: [],
        errors: [],
      },
    };

    const content = (provider as any)._formatResponse(response);

    expect(content).toContain('HTTP 101 WebSocket Exchange');
    expect(content).toContain('x-missio-protocol: websocket');
    expect(content).toContain('Runtime Results');
    expect(content).toContain('PASS socket echoed');
    expect(content).toContain('runtime.socketToken = ok');
  });
});
