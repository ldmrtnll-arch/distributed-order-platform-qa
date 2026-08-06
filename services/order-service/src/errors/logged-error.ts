export interface LoggedErrorDetails {
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

export function getLoggedErrorDetails(error: unknown): LoggedErrorDetails {
  const errorCode = readString(error, 'code');
  const errorName = readString(error, 'name');
  const details: LoggedErrorDetails = {};

  if (errorCode !== undefined) details.errorCode = errorCode;
  if (errorName !== undefined) details.errorName = errorName;

  return details;
}
