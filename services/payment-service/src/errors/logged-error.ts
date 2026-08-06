export interface LoggedErrorDetails {
  errorMessage: string;
  errorCode?: string;
  errorName?: string;
}

function readString(value: unknown, property: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;

  try {
    const propertyValue = Reflect.get(value, property);

    return typeof propertyValue === 'string' && propertyValue.trim() !== ''
      ? propertyValue
      : undefined;
  } catch {
    return undefined;
  }
}

function redactSensitiveDetails(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s@]+@/giu, '$1[REDACTED]@')
    .replace(/(password\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

export function getLoggedErrorDetails(error: unknown): LoggedErrorDetails {
  const rawMessage = readString(error, 'message');
  const errorCode = readString(error, 'code');
  const errorName = readString(error, 'name');
  const details: LoggedErrorDetails = {
    errorMessage:
      rawMessage === undefined
        ? 'Payment database request failed with an unrecognized error.'
        : redactSensitiveDetails(rawMessage),
  };

  if (errorCode !== undefined) details.errorCode = errorCode;
  if (errorName !== undefined) details.errorName = errorName;

  return details;
}
