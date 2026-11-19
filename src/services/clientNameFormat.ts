export function formatClientNameForReport(fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const [surname, ...givenNames] = parts;
  if (!surname) {
    return '';
  }

  const initials = givenNames
    .map((name) => `${Array.from(name)[0]?.toLocaleUpperCase('ru-RU') ?? ''}.`)
    .join('');

  return initials
    ? `${surname.toLocaleUpperCase('ru-RU')} ${initials}`
    : surname.toLocaleUpperCase('ru-RU');
}
