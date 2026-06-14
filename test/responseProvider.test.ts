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
});
