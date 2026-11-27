/**
 * What the readers and checks need from the platform that runs them. The caller builds one value
 * and passes it to each factory, such as createInputReaders.
 */
export type Platform = {
  /** The error that a reader or a check throws for input that cannot be used. */
  invalidInput: (message: string) => Error;
  /** How a yes/no field names its two values in a message, for example `yes or no`. */
  booleanWords: string;
};
