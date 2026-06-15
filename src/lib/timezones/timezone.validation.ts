export function isValidIanaTimezone(timezone: string): boolean {
  const normalizedTimezone = timezone.trim();

  if (!normalizedTimezone) {
    return false;
  }

  try {
    Intl.DateTimeFormat(undefined, {
      timeZone: normalizedTimezone,
    });

    return true;
  } catch {
    return false;
  }
}
