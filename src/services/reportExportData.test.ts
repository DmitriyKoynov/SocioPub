import { describe, expect, it } from 'vitest';
import { formatClientNameForReport } from './clientNameFormat';
import { mapServicesForReport } from './reportExportData';

describe('report export data', () => {
  it('omits unmapped and zero services and follows template order', () => {
    const services = mapServicesForReport(
      [
        { name: 'Неизвестная услуга', visitsByClientId: new Map([['client-1', 7]]) },
        { name: 'Демонстрационная услуга 02', visitsByClientId: new Map([['client-1', 0]]) },
        { name: 'Демонстрационная услуга 01', visitsByClientId: new Map([['client-1', 2]]) }
      ],
      ['client-1'],
      ['Демонстрационная услуга 02', 'Демонстрационная услуга 01']
    );
    expect(services.map((service) => service.name)).toEqual(['Демонстрационная услуга 01']);
    expect(services[0].visitsByClientId.get('client-1')).toBe(2);
  });
});

it('formats client names for the report', () => {
  expect(formatClientNameForReport('Иванов Иван Иванович')).toBe('ИВАНОВ И.И.');
});
