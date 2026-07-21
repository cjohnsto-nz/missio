import { describe, expect, it } from 'vitest';
import {
  applyRequestDefaultsEditorModel,
  applyRequestEditorModel,
  createRequestEditorModelFromRequest,
} from '../src/models/schemaRoundTrip';

describe('schema round-trip empty arrays', () => {
  it('preserves explicit empty HTTP params and headers on a no-op editor save', () => {
    const request = {
      info: { name: 'Empty request fields', type: 'http' },
      http: {
        method: 'GET',
        url: 'https://api.example.com/users',
        params: [],
        headers: [],
      },
    };

    const updated = applyRequestEditorModel(
      request,
      createRequestEditorModelFromRequest(request),
    );

    expect(updated).toEqual(request);
  });

  it('preserves empty header and variable arrays when editor rows are cleared', () => {
    const updated = applyRequestDefaultsEditorModel({
      headers: [{ name: 'Accept', value: 'application/json' }],
      variables: [{ name: 'region', value: 'nz' }],
      scripts: [{ type: 'before-request', code: 'console.log("keep");' }],
    }, {
      headers: [],
      variables: [],
    });

    expect(updated).toEqual({
      headers: [],
      variables: [],
      scripts: [{ type: 'before-request', code: 'console.log("keep");' }],
    });
  });
});
