export interface LoggedErrorDetails {
  errorMessage: string;
  errorCode?: string;
  errorName?: string;
}

function readNonEmptyStringProperty(value: unknown, property: string): string | undefined {
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

function redactSensitiveConnectionDetails(value: string): string {
  return value
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s@]+@/giu, '$1[REDACTED]@')
    .replace(/(password\s*[=:]\s*)[^\s,;]+/giu, '$1[REDACTED]');
}

function getFirstNestedError(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  try {
    const nestedErrors = Reflect.get(value, 'errors');
    return Array.isArray(nestedErrors) ? nestedErrors[0] : undefined;
  } catch {
    return undefined;
  }
}

export function getLoggedErrorDetails(error: unknown): LoggedErrorDetails {
  const nestedError = getFirstNestedError(error);
  const rawMessage =
    readNonEmptyStringProperty(error, 'message') ??
    readNonEmptyStringProperty(nestedError, 'message');
  const errorCode =
    readNonEmptyStringProperty(error, 'code') ??
    readNonEmptyStringProperty(nestedError, 'code');
  const errorName =
    readNonEmptyStringProperty(error, 'name') ??
    readNonEmptyStringProperty(nestedError, 'name');
  const details: LoggedErrorDetails = {
    errorMessage:
      rawMessage === undefined
        ? 'Inventory database request failed with an unrecognized error.'
        : redactSensitiveConnectionDetails(rawMessage),
  };

  if (errorCode !== undefined) details.errorCode = errorCode;
  if (errorName !== undefined) details.errorName = errorName;

  return details;
}
