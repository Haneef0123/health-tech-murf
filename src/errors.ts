/** An error with an HTTP status the API should return (instead of the default 502). */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
