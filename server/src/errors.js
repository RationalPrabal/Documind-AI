// An error that carries an HTTP status and a message that is safe to show
// to the client. Anything that is NOT an HttpError is treated as an
// internal error and its message is hidden from the client.
export class HttpError extends Error {
  constructor(status, message, { code, cause } = {}) {
    super(message, { cause });
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}
