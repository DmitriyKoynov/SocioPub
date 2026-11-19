import ExcelJS from 'exceljs';

/** Денежный формат «руб., две десятичные», русская локаль в Excel (419). */
export const NUM_FMT_RUB_RU = '#,##0.00 [$₽-419]';

export const EXCEL_BODY_FONT_SIZE = 11;
export const EXCEL_HEADER_FONT_SIZE = EXCEL_BODY_FONT_SIZE + 2;

const MIN_ROW_HEIGHT_PT = 14;
const ROW_HEIGHT_PADDING_PT = 1;

type MergeDimensions = {
  top: number;
  left: number;
  bottom: number;
  right: number;
};

type WorksheetWithMerges = ExcelJS.Worksheet & {
  _merges?: Record<string, MergeDimensions>;
};

export function excelColumnLetters(col1Based: number): string {
  let col = col1Based;
  let s = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

/** Число для подстановки в формулу OOXML (десятичная точка, без группировки). */
export function unitPriceLiteralForFormula(unit: number): string {
  if (!Number.isFinite(unit)) {
    return '0';
  }
  return unit.toLocaleString('en-US', {
    maximumFractionDigits: 10,
    useGrouping: false
  });
}

function getCellDisplayText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) {
    return '';
  }
  if (typeof v === 'string') {
    return v;
  }
  if (typeof v === 'number') {
    return String(v);
  }
  if (typeof v === 'boolean') {
    return v ? 'TRUE' : 'FALSE';
  }
  if (v instanceof Date) {
    return v.toLocaleString('ru-RU');
  }
  if (typeof v === 'object' && v !== null && 'formula' in v) {
    const fv = v as ExcelJS.CellFormulaValue;
    if (fv.result !== undefined && fv.result !== null && typeof fv.result !== 'object') {
      return String(fv.result);
    }
    const f = fv.formula || '';
    if (cell.numFmt === NUM_FMT_RUB_RU) {
      return '0,00 ₽';
    }
    if (/^SUM\s*\(/i.test(f)) {
      return '0';
    }
    if (/^\s*[A-Z]+\d+\s*\*\s*[A-Z]+\d+\s*$/i.test(f)) {
      return '0,00 ₽';
    }
    return f;
  }
  if (typeof v === 'object' && v !== null && 'richText' in v) {
    const rt = v as ExcelJS.CellRichTextValue;
    return rt.richText.map((t) => t.text).join('');
  }
  return String(v);
}

function cellDisplayLength(cell: ExcelJS.Cell): number {
  return getCellDisplayText(cell).length;
}

function getMergeDimensions(
  sheet: ExcelJS.Worksheet,
  row: number,
  col: number
): MergeDimensions | null {
  const ws = sheet as WorksheetWithMerges;
  const master = sheet.getCell(row, col).master;
  return ws._merges?.[master.address] ?? null;
}

function effectiveColWidthChars(
  sheet: ExcelJS.Worksheet,
  dim: MergeDimensions | null,
  col: number
): number {
  if (dim && dim.right > dim.left) {
    let total = 0;
    for (let c = dim.left; c <= dim.right; c++) {
      total += sheet.getColumn(c).width ?? 10;
    }
    return Math.max(1, Math.floor(total));
  }
  return Math.max(1, Math.floor(sheet.getColumn(col).width ?? 10));
}

/** Оценка числа строк при переносе по словам (ширина колонки в «символах» Excel). */
export function estimateWrappedLines(text: string, colWidthChars: number): number {
  if (!text) {
    return 1;
  }
  const width = Math.max(1, colWidthChars);
  let totalLines = 0;
  for (const paragraph of text.split(/\r?\n/)) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      totalLines += 1;
      continue;
    }
    let lines = 1;
    let currentLen = 0;
    for (const word of words) {
      if (currentLen === 0) {
        currentLen = word.length;
        continue;
      }
      if (currentLen + 1 + word.length <= width) {
        currentLen += 1 + word.length;
      } else {
        lines += 1;
        currentLen = word.length;
      }
    }
    totalLines += lines;
  }
  return Math.max(1, totalLines);
}

function cellFontSize(cell: ExcelJS.Cell): number {
  const size = cell.font?.size;
  return typeof size === 'number' ? size : EXCEL_BODY_FONT_SIZE;
}

function lineHeightPoints(fontSize: number): number {
  return fontSize * 1.15 + 0.5;
}

function isQtyColumn(col: number, qtyCols: number[] | undefined): boolean {
  return qtyCols?.includes(col) ?? false;
}

function columnWidthFromMaxLen(
  maxLen: number,
  tight: boolean
): { width: number; minW: number; maxW: number } {
  if (tight) {
    const minW = 4;
    const maxW = 14;
    const width = Math.min(Math.max(maxLen * 1.05 + 1.2, minW), maxW);
    return { width, minW, maxW };
  }
  const minW = 6;
  const maxW = 60;
  const padding = maxLen <= 12 ? 1.6 : 2.2;
  const width = Math.min(Math.max(maxLen * 1.12 + padding, minW), maxW);
  return { width, minW, maxW };
}

export interface SheetFormatBounds {
  firstCol: number;
  lastCol: number;
  firstRow: number;
  lastRow: number;
  /** Столбцы количества услуг (узкая ширина по контенту). */
  qtyCols?: number[];
  /** Первая строка таблицы — для авто-высоты строк. */
  tableFirstRow?: number;
}

/** Закрепляет первые два столбца при горизонтальной прокрутке в Excel. */
export function applyFrozenFirstTwoColumns(sheet: ExcelJS.Worksheet): void {
  sheet.views = [
    {
      state: 'frozen',
      xSplit: 2,
      ySplit: 0,
      topLeftCell: 'C1',
      activeCell: 'A1'
    }
  ];
}

function applyAutoRowHeights(
  sheet: ExcelJS.Worksheet,
  bounds: SheetFormatBounds
): void {
  const firstRow = bounds.tableFirstRow ?? bounds.firstRow;
  const qtyCols = bounds.qtyCols;

  for (let r = firstRow; r <= bounds.lastRow; r++) {
    let maxLines = 1;
    let maxFontSize = EXCEL_BODY_FONT_SIZE;

    for (let c = bounds.firstCol; c <= bounds.lastCol; c++) {
      const dim = getMergeDimensions(sheet, r, c);
      if (dim && c > dim.left) {
        continue;
      }

      const masterRow = dim?.top ?? r;
      const masterCol = dim?.left ?? c;
      const masterCell = sheet.getCell(masterRow, masterCol);
      const text = getCellDisplayText(masterCell);
      const fontSize = cellFontSize(masterCell);
      if (fontSize > maxFontSize) {
        maxFontSize = fontSize;
      }

      const widthChars = effectiveColWidthChars(sheet, dim, masterCol);
      const totalLines = isQtyColumn(masterCol, qtyCols)
        ? 1
        : estimateWrappedLines(text, widthChars);
      const rowSpan = dim ? dim.bottom - dim.top + 1 : 1;
      const linesForRow = totalLines / rowSpan;
      if (linesForRow > maxLines) {
        maxLines = linesForRow;
      }
    }

    const row = sheet.getRow(r);
    row.height = Math.max(
      MIN_ROW_HEIGHT_PT,
      Math.ceil(maxLines) * lineHeightPoints(maxFontSize) + ROW_HEIGHT_PADDING_PT
    );
  }
}

/**
 * AutoFit колонок, перенос текста и высота строк таблицы по контенту.
 * Столбцы qtyCols получают узкую ширину «по содержимому».
 */
export function applyAutoColumnWidthsAndWrap(
  sheet: ExcelJS.Worksheet,
  bounds: SheetFormatBounds,
  options?: { maxWidth?: number; minWidth?: number }
): void {
  const qtyCols = bounds.qtyCols;
  const defaultMaxW = options?.maxWidth ?? 60;
  const defaultMinW = options?.minWidth ?? 6;

  for (let c = bounds.firstCol; c <= bounds.lastCol; c++) {
    const tight = isQtyColumn(c, qtyCols);
    let maxLen = tight ? 1 : defaultMinW;
    for (let r = bounds.firstRow; r <= bounds.lastRow; r++) {
      const len = cellDisplayLength(sheet.getCell(r, c));
      if (len > maxLen) {
        maxLen = len;
      }
    }
    const { width } = columnWidthFromMaxLen(maxLen, tight);
    const clamped = tight
      ? width
      : Math.min(Math.max(width, defaultMinW), defaultMaxW);
    sheet.getColumn(c).width = clamped;

    const wrap = !tight;
    for (let r = bounds.firstRow; r <= bounds.lastRow; r++) {
      const cell = sheet.getCell(r, c);
      const prev = cell.alignment || {};
      cell.alignment = { ...prev, wrapText: wrap, vertical: wrap ? 'top' : 'middle' };
    }
  }

  if (bounds.tableFirstRow !== undefined) {
    applyAutoRowHeights(sheet, bounds);
  }
}
