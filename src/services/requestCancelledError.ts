export class RequestCancelledError extends Error {
  public readonly code = 'MISSIO_REQUEST_CANCELLED';

  constructor(message = 'Request cancelled') {
    super(message);
    this.name = 'RequestCancelledError';
  }
}
