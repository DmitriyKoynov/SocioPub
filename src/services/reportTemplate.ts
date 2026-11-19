import ExcelJS from 'exceljs';

const REPORT_TEMPLATE_PATH = `${import.meta.env.BASE_URL}${import.meta.env.VITE_REPORT_TEMPLATE_PATH || 'templates/report-template.demo.xlsx'}`;
const FIRST_SERVICE_ROW = 5;
const LAST_SERVICE_ROW = 54;

let templateBufferPromise: Promise<ArrayBuffer> | null = null;

async function loadTemplateBuffer(): Promise<ArrayBuffer> {
  if (!templateBufferPromise) {
    templateBufferPromise = fetch(REPORT_TEMPLATE_PATH).then(async (response) => {
      if (!response.ok) {
        throw new Error('Не удалось загрузить шаблон отчета Excel.');
      }
      return response.arrayBuffer();
    });
  }

  try {
    return await templateBufferPromise;
  } catch (error) {
    templateBufferPromise = null;
    throw error;
  }
}

export async function loadReportTemplateWorkbook(): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load((await loadTemplateBuffer()).slice(0));
  return workbook;
}

export function readReportTemplateTariffs(workbook: ExcelJS.Workbook): Record<string, number> {
  const sheet = workbook.getWorksheet('Лист1');
  if (!sheet) {
    throw new Error('В шаблоне отсутствует лист «Лист1».');
  }

  const tariffs: Record<string, number> = {};
  for (let row = FIRST_SERVICE_ROW; row <= LAST_SERVICE_ROW; row += 1) {
    const name = sheet.getCell(row, 1).text.trim();
    const value = sheet.getCell(row, 4).value;
    if (name && typeof value === 'number' && Number.isFinite(value)) {
      tariffs[name] = value;
    }
  }
  return tariffs;
}

export async function loadReportTemplateTariffs(): Promise<Record<string, number>> {
  return readReportTemplateTariffs(await loadReportTemplateWorkbook());
}
