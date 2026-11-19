import ExcelJS from 'exceljs';
import type { Client } from '../types';
import { formatClientNameForReport } from './clientNameFormat';
import { mapServicesForReport, type ExportServiceRow } from './reportExportData';
import { loadReportTemplateWorkbook } from './reportTemplate';

interface ReportPeriod {
  start: string;
  end: string;
}

export interface ExportReportToXlsxParams {
  socialWorker: string;
  organization: string;
  period: ReportPeriod;
  clients: Client[];
  services: ExportServiceRow[];
}

export interface ExportReportToXlsxResult {
  exportedRows: number;
  fileName: string;
}

const FIRST_SERVICE_ROW = 5;
const LAST_SERVICE_ROW = 54;
const FIRST_CLIENT_COLUMN = 5;
const TEMPLATE_CLIENT_CAPACITY = 25;
const TEMPLATE_CLIENT_SUMMARY_COLUMN = 55;
const TEMPLATE_MINUTES_SUMMARY_COLUMN = 56;

function getReportDate(period: ReportPeriod): Date {
  const rawDate = period.end || period.start;
  const match = rawDate.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) {
    return new Date(Number(match[3]), Number(match[2]) - 1, 1);
  }

  const date = rawDate ? new Date(rawDate) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : new Date(date.getFullYear(), date.getMonth(), 1);
}

function getMonthAndYear(period: ReportPeriod): { month: string; year: number } {
  const date = getReportDate(period);
  return {
    month: new Intl.DateTimeFormat('ru-RU', { month: 'long' }).format(date).toLocaleUpperCase('ru-RU'),
    year: date.getFullYear()
  };
}

function toExcelColumn(column: number): string {
  let value = column;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function copyCellStyle(source: ExcelJS.Cell, target: ExcelJS.Cell): void {
  target.style = { ...source.style };
}

function extendTemplateClientColumns(
  sheet: ExcelJS.Worksheet,
  clientCount: number
): { summaryColumn: number; minutesColumn: number } {
  const additionalClientCount = Math.max(0, clientCount - TEMPLATE_CLIENT_CAPACITY);
  if (additionalClientCount === 0) {
    return {
      summaryColumn: TEMPLATE_CLIENT_SUMMARY_COLUMN,
      minutesColumn: TEMPLATE_MINUTES_SUMMARY_COLUMN
    };
  }

  const summaryColumn = TEMPLATE_CLIENT_SUMMARY_COLUMN + additionalClientCount * 2;
  const minutesColumn = summaryColumn + 1;
  const rowCount = sheet.rowCount;
  const originalSummaryWidth = sheet.getColumn(TEMPLATE_CLIENT_SUMMARY_COLUMN).width;
  const originalMinutesWidth = sheet.getColumn(TEMPLATE_MINUTES_SUMMARY_COLUMN).width;

  sheet.unMergeCells('A1');
  sheet.unMergeCells('BC2:BC3');
  sheet.unMergeCells('BD2:BD3');

  for (let row = 1; row <= rowCount; row += 1) {
    const summarySource = sheet.getCell(row, TEMPLATE_CLIENT_SUMMARY_COLUMN);
    const minutesSource = sheet.getCell(row, TEMPLATE_MINUTES_SUMMARY_COLUMN);
    const summaryTarget = sheet.getCell(row, summaryColumn);
    const minutesTarget = sheet.getCell(row, minutesColumn);
    summaryTarget.value = summarySource.value;
    minutesTarget.value = minutesSource.value;
    copyCellStyle(summarySource, summaryTarget);
    copyCellStyle(minutesSource, minutesTarget);
  }
  sheet.getColumn(summaryColumn).width = originalSummaryWidth;
  sheet.getColumn(minutesColumn).width = originalMinutesWidth;

  for (let clientIndex = TEMPLATE_CLIENT_CAPACITY; clientIndex < clientCount; clientIndex += 1) {
    const quantityColumn = FIRST_CLIENT_COLUMN + clientIndex * 2;
    const amountColumn = quantityColumn + 1;
    sheet.getColumn(quantityColumn).width = sheet.getColumn(FIRST_CLIENT_COLUMN).width;
    sheet.getColumn(amountColumn).width = sheet.getColumn(FIRST_CLIENT_COLUMN + 1).width;

    for (let row = 1; row <= rowCount; row += 1) {
      const styleRow = row === LAST_SERVICE_ROW ? LAST_SERVICE_ROW - 1 : row;
      const quantityCell = sheet.getCell(row, quantityColumn);
      const amountCell = sheet.getCell(row, amountColumn);
      copyCellStyle(sheet.getCell(styleRow, FIRST_CLIENT_COLUMN), quantityCell);
      copyCellStyle(sheet.getCell(styleRow, FIRST_CLIENT_COLUMN + 1), amountCell);
      quantityCell.value = null;
      amountCell.value = null;
    }

    sheet.mergeCells(2, quantityColumn, 2, amountColumn);
    sheet.mergeCells(3, quantityColumn, 3, amountColumn);
    sheet.getCell(4, quantityColumn).value = 'услуг';
    sheet.getCell(4, amountColumn).value = 'сумма';
  }

  for (let row = 1; row <= rowCount; row += 1) {
    const quantityCell = sheet.getCell(row, TEMPLATE_CLIENT_SUMMARY_COLUMN);
    const amountCell = sheet.getCell(row, TEMPLATE_MINUTES_SUMMARY_COLUMN);
    quantityCell.value = null;
    amountCell.value = null;
    copyCellStyle(sheet.getCell(row, FIRST_CLIENT_COLUMN), quantityCell);
    copyCellStyle(sheet.getCell(row, FIRST_CLIENT_COLUMN + 1), amountCell);
  }

  sheet.mergeCells(2, summaryColumn, 3, summaryColumn);
  sheet.mergeCells(2, minutesColumn, 3, minutesColumn);
  sheet.getCell(2, summaryColumn).value = 'Всего услуг';
  sheet.getCell(2, minutesColumn).value = 'Минуты';
  sheet.mergeCells(1, 1, 1, minutesColumn);

  return { summaryColumn, minutesColumn };
}

function clearUnusedClientHeaders(sheet: ExcelJS.Worksheet, clientCount: number): void {
  for (let index = Math.min(clientCount, TEMPLATE_CLIENT_CAPACITY); index < TEMPLATE_CLIENT_CAPACITY; index += 1) {
    const quantityColumn = FIRST_CLIENT_COLUMN + index * 2;
    const amountColumn = quantityColumn + 1;
    sheet.getColumn(quantityColumn).hidden = true;
    sheet.getColumn(amountColumn).hidden = true;
    sheet.getCell(2, quantityColumn).value = null;
    sheet.getCell(3, quantityColumn).value = null;
  }
}

function getTemplateServiceRows(sheet: ExcelJS.Worksheet): Map<string, number[]> {
  const rowsByName = new Map<string, number[]>();
  for (let row = FIRST_SERVICE_ROW; row <= LAST_SERVICE_ROW; row += 1) {
    const name = sheet.getCell(row, 1).text.trim();
    if (name) {
      rowsByName.set(name, [...(rowsByName.get(name) ?? []), row]);
    }
  }
  return rowsByName;
}

function buildFileName(period: ReportPeriod): string {
  const { month, year } = getMonthAndYear(period);
  return `Отчет ${month} ${year}.xlsx`;
}

function updateTitle(sheet: ExcelJS.Worksheet, period: ReportPeriod): void {
  const { month, year } = getMonthAndYear(period);
  const titleCell = sheet.getCell('A1');
  titleCell.value = `Отчет социального работника за ${month} ${year} г.`;
}

function updateServiceRowFormulas(
  sheet: ExcelJS.Worksheet,
  clientCount: number,
  summaryColumn: number,
  minutesColumn: number,
  lastServiceRow: number
): void {
  const quantityColumns = Array.from({ length: clientCount }, (_, index) => FIRST_CLIENT_COLUMN + index * 2);
  const quantityReferences = quantityColumns.map((column) => toExcelColumn(column));
  for (let row = FIRST_SERVICE_ROW; row <= lastServiceRow; row += 1) {
    quantityColumns.forEach((quantityColumn, clientIndex) => {
      const amountColumn = quantityColumn + 1;
      sheet.getCell(row, amountColumn).value = {
        formula: `D${row}*${quantityReferences[clientIndex]}${row}`
      };
    });
    sheet.getCell(row, summaryColumn).value = {
      formula: quantityReferences.map((column) => `${column}${row}`).join('+') || '0'
    };
    sheet.getCell(row, minutesColumn).value = {
      formula: `${toExcelColumn(summaryColumn)}${row}*B${row}`
    };
  }
}

function updateTotalFormulas(
  sheet: ExcelJS.Worksheet,
  clientCount: number,
  minutesColumn: number,
  lastServiceRow: number
): void {
  const totalsRow = lastServiceRow + 1;
  for (let column = FIRST_CLIENT_COLUMN; column <= minutesColumn; column += 1) {
    const letter = toExcelColumn(column);
    sheet.getCell(totalsRow, column).value = {
      formula: `SUM(${letter}${FIRST_SERVICE_ROW}:${letter}${lastServiceRow})`
    };
  }
  const clientAmountColumns = Array.from({ length: clientCount }, (_, index) =>
    toExcelColumn(FIRST_CLIENT_COLUMN + index * 2 + 1)
  );
  sheet.getCell(totalsRow + 1, minutesColumn).value = {
    formula: clientAmountColumns.map((column) => `${column}${totalsRow}`).join('+') || '0'
  };
}

function insertClientTotalsRow(sheet: ExcelJS.Worksheet, minutesColumn: number): void {
  const sourceRow = sheet.getRow(LAST_SERVICE_ROW);
  sheet.insertRow(LAST_SERVICE_ROW + 1, []);
  const targetRow = sheet.getRow(LAST_SERVICE_ROW + 1);
  targetRow.height = sourceRow.height;
  for (let column = 1; column <= minutesColumn; column += 1) {
    copyCellStyle(sourceRow.getCell(column), targetRow.getCell(column));
  }
  for (let column = 1; column <= 4; column += 1) {
    targetRow.getCell(column).value = null;
  }
}

function setServiceRows(
  sheet: ExcelJS.Worksheet,
  services: ExportServiceRow[],
  clients: Client[],
  templateRowsByName: Map<string, number[]>,
  minutesColumn: number
): void {
  for (let row = FIRST_SERVICE_ROW; row <= LAST_SERVICE_ROW; row += 1) {
    sheet.getRow(row).hidden = true;
    sheet.getCell(row, 1).value = null;
    for (let column = FIRST_CLIENT_COLUMN; column < minutesColumn - 1; column += 2) {
      sheet.getCell(row, column).value = null;
    }
  }

  services.forEach((service) => {
    const row = templateRowsByName.get(service.name)?.[0];
    if (row === undefined) {
      throw new Error(`В шаблоне отсутствует услуга «${service.name}».`);
    }

    sheet.getRow(row).hidden = false;
    sheet.getCell(row, 1).value = service.name;
    clients.forEach((client, clientIndex) => {
      const quantityColumn = FIRST_CLIENT_COLUMN + clientIndex * 2;
      sheet.getCell(row, quantityColumn).value = service.visitsByClientId.get(client.id) ?? 0;
    });
  });
}

export const exportReportToXlsx = async ({
  period,
  clients,
  services
}: ExportReportToXlsxParams): Promise<ExportReportToXlsxResult> => {
  const workbook = await loadReportTemplateWorkbook();
  const sheet = workbook.getWorksheet('Лист1');
  if (!sheet) {
    throw new Error('В шаблоне отсутствует лист «Лист1».');
  }

  const templateServiceNames = Array.from({ length: LAST_SERVICE_ROW - FIRST_SERVICE_ROW + 1 }, (_, index) =>
    sheet.getCell(FIRST_SERVICE_ROW + index, 1).text.trim()
  ).filter(Boolean);
  const reportServices = mapServicesForReport(services, clients.map(({ id }) => id), templateServiceNames);
  if (reportServices.length === 0) {
    return { exportedRows: 0, fileName: '' };
  }

  const templateRowsByName = getTemplateServiceRows(sheet);
  const { summaryColumn, minutesColumn } = extendTemplateClientColumns(sheet, clients.length);
  sheet.unMergeCells('A56:D56');
  sheet.unMergeCells('A64:D64');
  sheet.unMergeCells('A65:D65');
  insertClientTotalsRow(sheet, minutesColumn);
  setServiceRows(sheet, reportServices, clients, templateRowsByName, minutesColumn);
  sheet.spliceRows(56, 2);
  for (let row = LAST_SERVICE_ROW; row >= FIRST_SERVICE_ROW; row -= 1) {
    if (sheet.getRow(row).hidden) {
      sheet.spliceRows(row, 1);
    }
  }
  sheet.eachRow({ includeEmpty: true }, (row) => { row.hidden = false; });
  const lastServiceRow = FIRST_SERVICE_ROW + reportServices.length - 1;
  updateServiceRowFormulas(sheet, clients.length, summaryColumn, minutesColumn, lastServiceRow);
  updateTitle(sheet, period);

  clients.forEach((client, index) => {
    const quantityColumn = FIRST_CLIENT_COLUMN + index * 2;
    sheet.getCell(2, quantityColumn).value = index + 1;
    sheet.getCell(3, quantityColumn).value = formatClientNameForReport(client.fullName);


  });
  clearUnusedClientHeaders(sheet, clients.length);

  updateTotalFormulas(sheet, clients.length, minutesColumn, lastServiceRow);
  sheet.eachRow({ includeEmpty: true }, (row) => row.eachCell({ includeEmpty: true }, (cell) => {
    if (cell.fill.type === 'pattern' && cell.fill.fgColor?.argb === 'FFFFFF00') {
      cell.fill = { type: 'pattern', pattern: 'none' };
    }
  }));
  workbook.calcProperties = { fullCalcOnLoad: true };

  const buffer = await workbook.xlsx.writeBuffer();
  const fileName = buildFileName(period);
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);

  return { exportedRows: reportServices.length, fileName };
};
