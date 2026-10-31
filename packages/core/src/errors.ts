/** Exit code 2: the command line or the environment is wrong. */
export class UsageError extends Error {}

/** Exit code 2: the map is unreadable or inconsistent. */
export class MapError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}
