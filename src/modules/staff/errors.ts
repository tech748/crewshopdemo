/** Domain error for staff operations; the route error handler maps it to an HTTP response. */
export class StaffOpError extends Error {
  constructor(public status: 400 | 404 | 409 | 423, public code: string, message = code, public extra: Record<string, unknown> = {}) { super(message); }
}
