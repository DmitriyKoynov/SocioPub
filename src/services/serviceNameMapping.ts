// The public mapping contains demonstration services only.
export const SOURCE_TO_REPORT_NAMES: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
    const name = `Демонстрационная услуга ${String(index + 1).padStart(2, '0')}`;
    return [name, [name]];
  }));
