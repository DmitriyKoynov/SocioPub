import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error Node type declarations are not part of the browser app.
import { readFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import type { Client } from '../types';
import { exportReportToXlsx } from './exportReport';
import { SOURCE_TO_REPORT_NAMES } from './serviceNameMapping';
import { fakeApiService } from './fakeApi';

const templateBytes = readFileSync(new URL('../../public/templates/report-template.demo.xlsx', import.meta.url));

async function prepareDownload(): Promise<{
  getWorkbook: () => Promise<ExcelJS.Workbook>;
  anchor: { click: ReturnType<typeof vi.fn>; download: string };
}> {
  let outputBlob: Blob | null = null;
  const anchor = { href: '', download: '', click: vi.fn() };
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => templateBytes.buffer.slice(
      templateBytes.byteOffset,
      templateBytes.byteOffset + templateBytes.byteLength
    )
  })));
  vi.stubGlobal('document', { createElement: vi.fn(() => anchor) });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    outputBlob = blob as Blob;
    return 'blob:report-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

  return {
    anchor,
    getWorkbook: async () => {
      if (!outputBlob) {
        throw new Error('Exporter did not create a workbook download.');
      }
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(await outputBlob.arrayBuffer());
      return workbook;
    }
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('exportReportToXlsx', () => {
  it('exports every demo service using the real report template', async () => {
    const demoServices = await fakeApiService.getServices();
    const download = await prepareDownload();
    const result = await exportReportToXlsx({
      socialWorker: 'Иванов И.И.',
      organization: 'Организация',
      period: { start: '01.11.2026', end: '30.11.2026' },
      clients: [{ id: 'demo-client', fullName: 'Иванов Иван Иванович' }],
      services: demoServices.map(({ name }) => ({
        name,
        visitsByClientId: new Map([['demo-client', 1]])
      }))
    });

    const workbook = await download.getWorkbook();
    const sheet = workbook.getWorksheet('Лист1')!;
    expect(result.exportedRows).toBe(demoServices.length);
    for (const { name } of demoServices) {
      const reportNames = SOURCE_TO_REPORT_NAMES[name];
      expect(reportNames).toHaveLength(1);
      const row = sheet.getRows(5, 50)!.find((item) => item.getCell(1).text === reportNames[0]);
      expect(row?.getCell(5).value).toBe(1);
    }
    expect(download.anchor.click).toHaveBeenCalledOnce();
  });

  it('removes unused service rows and preserves totals for fewer than 25 clients', async () => {
    const targetServiceName = 'Демонстрационная услуга 01';
    const sourceServiceName = Object.entries(SOURCE_TO_REPORT_NAMES)
      .find(([, targets]) => targets.includes(targetServiceName))?.[0];
    const download = await prepareDownload();

    await exportReportToXlsx({
      socialWorker: 'Иванов И.И.',
      organization: 'Организация',
      period: { start: '01.11.2026', end: '30.11.2026' },
      clients: [{ id: 'client-1', fullName: 'Иванов Иван Иванович' }],
      services: [{ name: sourceServiceName!, visitsByClientId: new Map([['client-1', 2]]) }]
    });

    const workbook = await download.getWorkbook();
    const sheet = workbook.getWorksheet('Лист1')!;
    expect(sheet.getCell('E3').text).toBe('ИВАНОВ И.И.');
    expect(sheet.getColumn('W').hidden).toBe(true);
    expect(sheet.getColumn('X').hidden).toBe(true);
    expect(sheet.getCell('A5').text).toBe(targetServiceName);
    expect(sheet.getCell('E5').value).toBe(2);
    expect(sheet.getCell('F5').formula).toBe('D5*E5');
    expect(sheet.getCell('BC6').formula).toBe('SUM(BC5:BC5)');
    expect(sheet.getCell('BD7').formula).toBe('F6');
    sheet.eachRow((row) => {
      expect(row.hidden, `row ${row.number}`).not.toBe(true);
      expect(row.getCell(1).text).not.toMatch(/ПАМПЕРС|% Загрузки/i);
    });
  });

  it('extends the styled template when a month has more than 25 clients', async () => {
    const targetServiceName = 'Демонстрационная услуга 01';
    const sourceServiceName = Object.entries(SOURCE_TO_REPORT_NAMES)
      .find(([, targets]) => targets.includes(targetServiceName))?.[0];
    expect(sourceServiceName).toBeDefined();

    const clients: Client[] = Array.from({ length: 27 }, (_, index) => ({
      id: `client-${index + 1}`,
      fullName: index === 0
        ? 'Иванов Иван Иванович'
        : index === 26
          ? 'Петров Петр Петрович'
          : `Клиент${index + 1} Имя Отчество`
    }));
    const visitsByClientId = new Map<string, number>([
      ['client-1', 3],
      ['client-27', 1]
    ]);
    const download = await prepareDownload();

    const result = await exportReportToXlsx({
      socialWorker: 'Иванов И.И.',
      organization: 'Организация',
      period: { start: '01.10.2026', end: '31.10.2026' },
      clients,
      services: [{ name: sourceServiceName!, visitsByClientId }]
    });

    const workbook = await download.getWorkbook();
    const sheet = workbook.getWorksheet('Лист1')!;
    let decoratedFontCount = 0;
    workbook.worksheets.forEach((currentSheet) => {
      currentSheet.eachRow({ includeEmpty: true }, (row) => {
        row.eachCell({ includeEmpty: true }, (cell) => {
          const font = cell.font as typeof cell.font & { shadow?: boolean };
          if (font.strike || font.outline || font.shadow) {
            decoratedFontCount += 1;
          }
        });
      });
    });
    expect(result.exportedRows).toBe(1);
    expect(result.fileName).toBe('Отчет ОКТЯБРЬ 2026.xlsx');
    expect(download.anchor.download).toBe(result.fileName);
    expect(sheet.getCell('A1').text).toContain('за ОКТЯБРЬ 2026 г.');
    expect(sheet.getCell('A1').font.strike).not.toBe(true);
    expect(sheet.getCell('A1').font.outline).not.toBe(true);
    expect(sheet.getCell('A6').font.strike).not.toBe(true);
    expect(sheet.getCell('A6').font.outline).not.toBe(true);
    expect(sheet.getCell('E6').font.strike).not.toBe(true);
    expect(sheet.getCell('E6').font.outline).not.toBe(true);
    expect(decoratedFontCount).toBe(0);
    expect(sheet.getCell('A5').text).toBe(targetServiceName);
    expect(sheet.getCell('E5').value).toBe(3);
    expect(sheet.getCell('BE5').value).toBe(1);
    expect(sheet.getCell('BF5').formula).toBe('D5*BE5');
    expect(sheet.getCell('BG5').formula).toContain('BE5');
    expect(sheet.getCell('BH5').formula).toBe('BG5*B5');
    expect(sheet.getCell('E3').text).toBe('ИВАНОВ И.И.');
    expect(sheet.getCell('BE3').text).toBe('ПЕТРОВ П.П.');
    sheet.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (cell) => {
      if (cell.fill.type === 'pattern') {
        expect(cell.fill.fgColor?.argb).not.toBe('FFFFFF00');
      }
    }));
    for (const amountHeader of ['F4', 'BB4', 'BD4', 'BF4']) {
      expect((sheet.getCell(amountHeader).fill as { fgColor?: { argb?: string } }).fgColor?.argb).toBe('FF00CCFF');
    }
    expect(sheet.getCell('BG6').formula).toBe('SUM(BG5:BG5)');
    expect(sheet.getCell('BH7').formula).toContain('BF6');
    expect(sheet.getColumn('BC').width).toBe(sheet.getColumn('E').width);
    expect(sheet.getColumn('BD').width).toBe(sheet.getColumn('F').width);
    expect((sheet.getCell('BG3') as unknown as { isMerged: boolean }).isMerged).toBe(true);
    expect((sheet.getCell('BH1') as unknown as { isMerged: boolean }).isMerged).toBe(true);
  });
});
