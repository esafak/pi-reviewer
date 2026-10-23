/**
 * A fetch the reader refused or could not complete.
 *
 * The reason is written for the model, not for the operator: the reader's
 * refusals are recoverable — the model may try another candidate location —
 * so the message says what was wrong with the location rather than what went
 * wrong inside the transport.
 */
export class WebFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebFetchError";
  }
}
